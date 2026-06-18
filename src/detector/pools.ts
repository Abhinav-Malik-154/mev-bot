/**
 * @file src/detector/pools.ts
 * @description Uniswap V2 pool reserve fetcher.
 *
 * Every Uniswap V2 pool is a smart contract with a getReserves()
 * function that returns the current token balances.
 * We fetch these reserves to know the current pool price.
 *
 * Why do we need two pools?
 * Arbitrage requires a price difference between two pools.
 * Pool A might have a different ETH/USDC price than Pool B
 * because they have different liquidity compositions.
 *
 * The Uniswap V2 Factory contract computes pool addresses
 * deterministically from token addresses — no lookup needed.
 *
 * Pool address formula (CREATE2):
 * keccak256(token0, token1) + factory address + init code hash
 */

import { JsonRpcProvider, Contract, getAddress, keccak256, solidityPacked } from 'ethers';
import { createModuleLogger } from '../utils/logger.js';
import type { PoolReserves } from '../types/index.js';

const logger = createModuleLogger('pools');

export const UNISWAP_V2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
export const UNISWAP_V2_INIT_CODE_HASH =
  '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f';

const PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
] as const;

const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
] as const;

// Exported so arbitrage.ts can reference it without an extra provider call
export { FACTORY_ABI };

// Typed interface avoids noUncheckedIndexedAccess errors from Contract bracket access
interface UniswapV2Pair {
  getReserves(): Promise<[bigint, bigint, number]>;
  token0(): Promise<string>;
  token1(): Promise<string>;
}

/**
 * Sorts two token addresses (Uniswap V2 requires token0 < token1).
 * Returns [token0, token1] in sorted order.
 */
export function sortTokens(tokenA: string, tokenB: string): [string, string] {
  const a = getAddress(tokenA).toLowerCase();
  const b = getAddress(tokenB).toLowerCase();
  return a < b ? [getAddress(tokenA), getAddress(tokenB)] : [getAddress(tokenB), getAddress(tokenA)];
}

/**
 * Computes Uniswap V2 pair address deterministically using CREATE2.
 * This avoids an on-chain call to the factory contract.
 * Tokens are sorted by address before computing (Uniswap requirement).
 */
export function computePairAddress(
  tokenA: string,
  tokenB: string,
  factoryAddress: string,
  initCodeHash: string,
): string {
  const [token0, token1] = sortTokens(tokenA, tokenB);
  const salt = keccak256(
    solidityPacked(['address', 'address'], [token0, token1]),
  );
  const factoryLower = getAddress(factoryAddress).toLowerCase();
  // CREATE2: keccak256(0xff ++ factory ++ salt ++ initCodeHash)[12:]
  const hash = keccak256(
    solidityPacked(
      ['bytes1', 'address', 'bytes32', 'bytes32'],
      ['0xff', factoryLower, salt, initCodeHash],
    ),
  );
  // Take the last 20 bytes (40 hex chars) as the address
  return getAddress('0x' + hash.slice(-40));
}

/**
 * Fetches current reserves from a Uniswap V2 pool contract.
 * Returns reserves in token0/token1 order (sorted by address).
 * Returns null if pool does not exist or call fails.
 */
export async function getPoolReserves(
  pairAddress: string,
  provider: JsonRpcProvider,
): Promise<PoolReserves | null> {
  try {
    const pair = new Contract(pairAddress, PAIR_ABI, provider) as unknown as UniswapV2Pair;
    const [reserve0, reserve1] = await pair.getReserves();
    const token0 = await pair.token0();
    const token1 = await pair.token1();

    if (reserve0 === 0n && reserve1 === 0n) return null;

    return {
      reserve0,
      reserve1,
      token0: getAddress(token0),
      token1: getAddress(token1),
      fee: 30,
    };
  } catch (err: unknown) {
    logger.debug({ pairAddress, err }, 'getPoolReserves failed');
    return null;
  }
}

/**
 * Fetches reserves for multiple pools in parallel using Promise.all.
 * More efficient than sequential fetches for the hot path.
 * Filters out null results (non-existent pools).
 */
export async function getMultiplePoolReserves(
  pairAddresses: string[],
  provider: JsonRpcProvider,
): Promise<Map<string, PoolReserves>> {
  const results = await Promise.all(
    pairAddresses.map(async (addr) => {
      const reserves = await getPoolReserves(addr, provider);
      return [addr, reserves] as const;
    }),
  );

  const map = new Map<string, PoolReserves>();
  for (const [addr, reserves] of results) {
    if (reserves !== null) {
      map.set(addr, reserves);
    }
  }
  return map;
}
