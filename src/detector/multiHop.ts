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

/**
 * Orients a pool's reserves for a swap from `tokenIn` to `tokenOut`.
 * Fetches reserves once, then maps reserve0/reserve1 to in/out using the
 * pool's sorted token order. Returns null if the pool is missing/empty.
 */
async function reservesForHop(
  poolAddress: string,
  tokenIn: string,
  tokenOut: string,
  provider: JsonRpcProvider,
): Promise<{ reserveIn: bigint; reserveOut: bigint } | null> {
  const reserves = await getPoolReserves(poolAddress, provider);
  if (reserves === null) return null;

  const [token0] = sortTokens(tokenIn, tokenOut);
  const inIsToken0 = tokenIn.toLowerCase() === token0.toLowerCase();
  return {
    reserveIn: inIsToken0 ? reserves.reserve0 : reserves.reserve1,
    reserveOut: inIsToken0 ? reserves.reserve1 : reserves.reserve0,
  };
}

/**
 * Calculates the final output of executing a full triangular path.
 * Chains getAmountOut through all three pools sequentially, returning the
 * amount of the start token recovered. Returns 0n if any leg's pool is
 * missing/empty or any intermediate amount collapses to zero.
 */
export async function simulateTriangularPath(
  path: TriangularPath,
  amountIn: bigint,
  provider: JsonRpcProvider,
): Promise<bigint> {
  if (amountIn <= 0n) return 0n;

  const [t0, t1, t2] = path.tokens;
  const [p0, p1, p2] = path.pools;

  // The loop's hops: t0->t1, t1->t2, t2->t0.
  const legs: ReadonlyArray<{ pool: string; tokenIn: string; tokenOut: string }> = [
    { pool: p0, tokenIn: t0, tokenOut: t1 },
    { pool: p1, tokenIn: t1, tokenOut: t2 },
    { pool: p2, tokenIn: t2, tokenOut: t0 },
  ];

  let amount = amountIn;
  for (const leg of legs) {
    const oriented = await reservesForHop(leg.pool, leg.tokenIn, leg.tokenOut, provider);
    if (oriented === null) return 0n;
    amount = getAmountOut(amount, oriented.reserveIn, oriented.reserveOut);
    if (amount === 0n) return 0n;
  }
  return amount;
}

/**
 * Searches all triangular paths from a starting token and amount, returning
 * the most profitable opportunity found (or null if none is profitable).
 *
 * Paths are simulated in parallel — each is independent and the per-path cost
 * is three read-only reserve fetches.
 */
export async function findBestTriangularArbitrage(
  startToken: string,
  testAmountIn: bigint,
  provider: JsonRpcProvider,
): Promise<TriangularOpportunity | null> {
  if (testAmountIn <= 0n) return null;

  const paths = generateTriangularPaths(startToken, HUB_TOKENS);

  const results = await Promise.all(
    paths.map(async (path): Promise<TriangularOpportunity | null> => {
      const finalAmountOut = await simulateTriangularPath(path, testAmountIn, provider);
      if (finalAmountOut <= testAmountIn) return null;
      return {
        path,
        startAmountIn: testAmountIn,
        finalAmountOut,
        profitWei: finalAmountOut - testAmountIn,
        isProfitable: true,
      };
    }),
  );

  let best: TriangularOpportunity | null = null;
  for (const result of results) {
    if (result === null) continue;
    if (best === null || result.profitWei > best.profitWei) {
      best = result;
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
