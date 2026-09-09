/**
 * @file src/detector/multiHop.ts
 * @description Multi-hop (triangular) arbitrage path finder.
 *
 * Triangular arbitrage: start with token A, swap to B, swap to C,
 * swap back to A. If the product of exchange rates around the
 * loop is greater than 1, the path is profitable.
 *
 * Example: ETH -> USDC -> DAI -> ETH
 * If ETH/USDC rate * USDC/DAI rate * DAI/ETH rate > 1, profit exists.
 *
 * Why this matters beyond 2-pool arbitrage:
 * Triangular paths exist that 2-pool comparison never finds —
 * the inefficiency is distributed across 3 pools, each individually
 * "fairly priced" against the others, but the loop has slippage.
 *
 * Complexity: with N tradeable tokens, there are O(N^2) possible
 * 3-hop paths. We limit search to a fixed set of "hub" tokens
 * (WETH, USDC, USDT, DAI) to keep this computationally feasible.
 */

import type { JsonRpcProvider } from 'ethers';
import type { PoolReserves } from '../types/index.js';
import { createModuleLogger } from '../utils/logger.js';
import { getAmountOut } from './math.js';
import {
  computePairAddress,
  getPoolReserves,
  sortTokens,
  UNISWAP_V2_FACTORY,
  UNISWAP_V2_INIT_CODE_HASH,
} from './pools.js';

const logger = createModuleLogger('multiHop');

/**
 * Hub tokens for path construction (Sepolia testnet addresses).
 * Restricting intermediate hops to these deep-liquidity tokens keeps the
 * triangular search bounded — every path is start -> hub -> hub -> start.
 */
export const HUB_TOKENS: ReadonlyArray<{ symbol: string; address: string }> = [
  { symbol: 'WETH', address: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9' },
  { symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  { symbol: 'DAI', address: '0x68194a729C2450ad26072b3D33ADaCbcef39D574' },
];

export interface TriangularPath {
  /** The three tokens of the loop in order; the loop returns to tokens[0]. */
  tokens: [string, string, string];
  /** Pool addresses for each leg: (t0->t1), (t1->t2), (t2->t0). */
  pools: [string, string, string];
}

export interface TriangularOpportunity {
  /** The path that produced this result. */
  path: TriangularPath;
  /** Input amount used to evaluate the path, in tokens[0]'s smallest unit. */
  startAmountIn: bigint;
  /** Amount of tokens[0] recovered after the full three-leg loop. */
  finalAmountOut: bigint;
  /** finalAmountOut - startAmountIn; never negative (0 when unprofitable). */
  profitWei: bigint;
  /** True when finalAmountOut strictly exceeds startAmountIn. */
  isProfitable: boolean;
}

/**
 * Computes the Uniswap V2 pool address for a token pair on the primary
 * factory. Centralised so path generation and simulation stay consistent.
 */
function poolFor(tokenA: string, tokenB: string): string {
  return computePairAddress(tokenA, tokenB, UNISWAP_V2_FACTORY, UNISWAP_V2_INIT_CODE_HASH);
}

/**
 * Generates all possible triangular paths starting and ending at the given
 * token, routing through the hub tokens. The start token is excluded from
 * the intermediate hops (a path never revisits its start mid-loop), and the
 * two intermediate hops are always distinct, so each path is a genuine cycle:
 *
 *   start -> B -> C -> start   (B != C, both hub tokens, neither == start)
 *
 * With k hub tokens available after removing the start, this yields k*(k-1)
 * ordered paths.
 */
export function generateTriangularPaths(
  startToken: string,
  hubTokens: ReadonlyArray<{ symbol: string; address: string }>,
): TriangularPath[] {
  const start = startToken.toLowerCase();
  const candidates = hubTokens.filter((t) => t.address.toLowerCase() !== start);

  const paths: TriangularPath[] = [];
  for (const b of candidates) {
    for (const c of candidates) {
      if (b.address.toLowerCase() === c.address.toLowerCase()) continue;
      paths.push({
        tokens: [startToken, b.address, c.address],
        pools: [
          poolFor(startToken, b.address),
          poolFor(b.address, c.address),
          poolFor(c.address, startToken),
        ],
      });
    }
  }
  return paths;
}


/** A pool's reserves keyed by lower-cased pool address. */
type ReserveSnapshot = ReadonlyMap<string, PoolReserves>;

/**
 * The three legs of a triangular loop: t0->t1, t1->t2, t2->t0.
 */
function legsOf(
  path: TriangularPath,
): ReadonlyArray<{ pool: string; tokenIn: string; tokenOut: string }> {
  const [t0, t1, t2] = path.tokens;
  const [p0, p1, p2] = path.pools;
  return [
    { pool: p0, tokenIn: t0, tokenOut: t1 },
    { pool: p1, tokenIn: t1, tokenOut: t2 },
    { pool: p2, tokenIn: t2, tokenOut: t0 },
  ];
}

/**
 * Fetches every distinct pool named by `paths` in one parallel batch.
 *
 * Distinct matters: `computePairAddress` sorts its token pair, so the two
 * directions of a hub loop (WETH->USDC->DAI->WETH and WETH->DAI->USDC->WETH)
 * name the *same* three pools. Fetching per path would request each pool
 * once per path that mentions it.
 *
 * Pricing every path from a single batch also means they share one
 * consistent view of the chain rather than a view that drifts between legs.
 */
async function fetchReserveSnapshot(
  paths: ReadonlyArray<TriangularPath>,
  provider: JsonRpcProvider,
): Promise<ReserveSnapshot> {
  const uniquePools = new Map<string, string>();
  for (const path of paths) {
    for (const pool of path.pools) uniquePools.set(pool.toLowerCase(), pool);
  }

  const entries = await Promise.all(
    [...uniquePools].map(async ([key, address]): Promise<[string, PoolReserves] | null> => {
      const reserves = await getPoolReserves(address, provider);
      return reserves === null ? null : [key, reserves];
    }),
  );

  const snapshot = new Map<string, PoolReserves>();
  for (const entry of entries) {
    if (entry !== null) snapshot.set(entry[0], entry[1]);
  }
  return snapshot;
}

/**
 * Orients a snapshot entry for a swap from `tokenIn` to `tokenOut`.
 * Returns null when the pool is absent from the snapshot.
 */
function orientFromSnapshot(
  snapshot: ReserveSnapshot,
  poolAddress: string,
  tokenIn: string,
  tokenOut: string,
): { reserveIn: bigint; reserveOut: bigint } | null {
  const reserves = snapshot.get(poolAddress.toLowerCase());
  if (reserves === undefined) return null;

  const [token0] = sortTokens(tokenIn, tokenOut);
  const inIsToken0 = tokenIn.toLowerCase() === token0.toLowerCase();
  return {
    reserveIn: inIsToken0 ? reserves.reserve0 : reserves.reserve1,
    reserveOut: inIsToken0 ? reserves.reserve1 : reserves.reserve0,
  };
}

/**
 * Pure evaluation of a triangular loop against an already-fetched snapshot.
 * Chains getAmountOut through the three pools, returning the amount of the
 * start token recovered. Returns 0n if any leg's pool is missing/empty or
 * any intermediate amount collapses to zero. No network access.
 */
export function simulateTriangularPathFromReserves(
  path: TriangularPath,
  amountIn: bigint,
  snapshot: ReserveSnapshot,
): bigint {
  if (amountIn <= 0n) return 0n;

  let amount = amountIn;
  for (const leg of legsOf(path)) {
    const oriented = orientFromSnapshot(snapshot, leg.pool, leg.tokenIn, leg.tokenOut);
    if (oriented === null) return 0n;
    amount = getAmountOut(amount, oriented.reserveIn, oriented.reserveOut);
    if (amount === 0n) return 0n;
  }
  return amount;
}

/**
 * Calculates the final output of executing a full triangular path.
 *
 * The three legs must be *evaluated* in order — each hop's input is the
 * previous hop's output — but the reserve *fetches* depend only on the pool
 * addresses, which are known up front. They are therefore issued as one
 * parallel batch instead of three sequential round-trips.
 */
export async function simulateTriangularPath(
  path: TriangularPath,
  amountIn: bigint,
  provider: JsonRpcProvider,
): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  const snapshot = await fetchReserveSnapshot([path], provider);
  return simulateTriangularPathFromReserves(path, amountIn, snapshot);
}

/**
 * Searches all triangular paths from a starting token and amount, returning
 * the most profitable opportunity found (or null if none is profitable).
 *
 * Every distinct pool across every path is fetched in a single parallel
 * batch, then each path is scored purely against that snapshot. Starting
 * from WETH over the hub set this is 3 pool reads total, not 3 per path.
 */
export async function findBestTriangularArbitrage(
  startToken: string,
  testAmountIn: bigint,
  provider: JsonRpcProvider,
): Promise<TriangularOpportunity | null> {
  if (testAmountIn <= 0n) return null;

  const paths = generateTriangularPaths(startToken, HUB_TOKENS);
  const snapshot = await fetchReserveSnapshot(paths, provider);

  let best: TriangularOpportunity | null = null;
  for (const path of paths) {
    const finalAmountOut = simulateTriangularPathFromReserves(path, testAmountIn, snapshot);
    if (finalAmountOut <= testAmountIn) continue;
    const profitWei = finalAmountOut - testAmountIn;
    if (best === null || profitWei > best.profitWei) {
      best = {
        path,
        startAmountIn: testAmountIn,
        finalAmountOut,
        profitWei,
        isProfitable: true,
      };
    }
  }

  if (best !== null) {
    logger.debug(
      {
        tokens: best.path.tokens,
        profitWei: best.profitWei.toString(),
      },
      'Triangular arbitrage candidate found',
    );
  }

  return best;
}
