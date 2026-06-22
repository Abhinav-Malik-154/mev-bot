/**
 * @file src/detector/uniswapV3.ts
 * @description Uniswap V3 pool reading and price calculation.
 *
 * V3 pools store price as sqrtPriceX96 — the square root of the
 * price, scaled by 2^96 for fixed-point precision. This avoids
 * precision loss that would occur storing the price directly.
 *
 * Unlike V2's simple reserve ratio, V3 price depends on which
 * "tick" (price range) currently has active liquidity. We read
 * slot0() for the current price and tick, then liquidity() for
 * the active liquidity at that tick.
 *
 * Why support V3 alongside V2?
 * V2 and V3 pools for the same pair often have different prices
 * because V3's concentrated liquidity reacts differently to large
 * swaps. This price divergence IS the arbitrage opportunity.
 */

import {
  Contract,
  getAddress,
  keccak256,
  solidityPacked,
  AbiCoder,
  type JsonRpcProvider,
} from 'ethers';
import { createModuleLogger } from '../utils/logger.js';
import { sortTokens } from './pools.js';

const logger = createModuleLogger('uniswapV3');

/**
 * Uniswap V3 factory on Sepolia (the network this bot targets).
 *
 * NOTE: the canonical mainnet factory lives at
 * 0x1F98431c8aD98523631AE4a59f267346ea31F984. We default to the Sepolia
 * deployment because the rest of the detector uses Sepolia token addresses;
 * callers can pass any factory explicitly to `computeV3PoolAddress`.
 */
export const UNISWAP_V3_FACTORY = '0x0227628f3F023bb0B980b67D528571c95C6DAC18';

/**
 * keccak256 of the UniswapV3Pool creation bytecode. Identical across every
 * EVM chain, so deterministic CREATE2 address computation works everywhere.
 */
export const UNISWAP_V3_POOL_INIT_CODE_HASH =
  '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54';

/** 2^96 — the fixed-point scaling factor used by all V3 sqrtPrice math. */
const Q96 = 2n ** 96n;
/** 2^192 = (2^96)^2 — appears when squaring sqrtPriceX96 to recover price. */
const Q192 = Q96 * Q96;
/** V3 fees are expressed in hundredths of a bip; 10^6 = 100%. */
const FEE_UNIT = 1_000_000n;
/** Standard price scaling for human-readable ratios (1e18 fixed point). */
const PRICE_SCALE = 10n ** 18n;

/** Standard V3 fee tiers in hundredths of a bip: 0.01%, 0.05%, 0.3%, 1%. */
export const V3_FEE_TIERS: readonly number[] = [100, 500, 3000, 10000];

// Only the slots we actually read — keeps the ABI surface minimal.
const V3_POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() external view returns (uint128)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)',
] as const;

const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
] as const;

export { V3_FACTORY_ABI };

// Typed shapes avoid noUncheckedIndexedAccess issues from Contract bracket access.
interface UniswapV3Pool {
  slot0(): Promise<
    [bigint, bigint, bigint, bigint, bigint, bigint, boolean]
  >;
  liquidity(): Promise<bigint>;
  token0(): Promise<string>;
  token1(): Promise<string>;
  fee(): Promise<bigint>;
}

export interface V3PoolState {
  /** Current price as sqrt(token1/token0) * 2^96, fixed-point. */
  sqrtPriceX96: bigint;
  /** Current tick (log_1.0001 of the price). */
  tick: number;
  /** Active liquidity (L) in the current tick range. */
  liquidity: bigint;
  /** Lower-address token (V3 sorts identically to V2). */
  token0: string;
  /** Higher-address token. */
  token1: string;
  /** Pool fee in hundredths of a bip (e.g. 3000 = 0.3%). */
  fee: number;
}

/**
 * Fetches current V3 pool state (price, tick, liquidity).
 * Returns null if the pool does not exist or any call reverts.
 */
export async function getV3PoolState(
  poolAddress: string,
  provider: JsonRpcProvider,
): Promise<V3PoolState | null> {
  try {
    const pool = new Contract(poolAddress, V3_POOL_ABI, provider) as unknown as UniswapV3Pool;
    const [slot0, liquidity, token0, token1, fee] = await Promise.all([
      pool.slot0(),
      pool.liquidity(),
      pool.token0(),
      pool.token1(),
      pool.fee(),
    ]);

    const sqrtPriceX96 = slot0[0];
    if (sqrtPriceX96 === 0n) {
      // Uninitialised pool — no price to read.
      return null;
    }

    return {
      sqrtPriceX96,
      tick: Number(slot0[1]),
      liquidity,
      token0: getAddress(token0),
      token1: getAddress(token1),
      fee: Number(fee),
    };
  } catch (err: unknown) {
    logger.debug({ poolAddress, err }, 'getV3PoolState failed');
    return null;
  }
}

/**
 * Converts sqrtPriceX96 to a human-readable price ratio.
 *
 *   price = (sqrtPriceX96 / 2^96)^2  ->  token1 per token0 in raw units
 *
 * We then adjust for the tokens' decimals and scale by 10^18 so the result
 * is an integer fixed-point value (1e18 == a price of 1.0). Returns the
 * price of token1 expressed in terms of token0.
 *
 * Pure integer math throughout — no floating point touches a price.
 */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  token0Decimals: number,
  token1Decimals: number,
): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  // rawPrice (scaled by 1e18) = sqrtPriceX96^2 / 2^192, then decimal-adjusted.
  // Multiply the numerator by 10^token0Decimals and divide by 10^token1Decimals
  // to convert from raw smallest-unit ratio to a human token ratio.
  const numerator =
    sqrtPriceX96 * sqrtPriceX96 * PRICE_SCALE * 10n ** BigInt(token0Decimals);
  const denominator = Q192 * 10n ** BigInt(token1Decimals);
  return numerator / denominator;
}

/**
 * Estimates output amount for a V3 swap using a simplified single-tick
 * approximation (assumes the swap does not cross tick boundaries).
 *
 * This is an approximation — exact V3 math requires tick-by-tick iteration,
 * which is too slow for the bot's hot path. For arbitrage detection this
 * approximation is sufficient to flag opportunities; the Anvil simulation
 * in Phase 4 will catch any approximation error before submission.
 *
 * Uses the canonical Uniswap V3 SqrtPriceMath relations within one tick:
 *   - zeroForOne (token0 in): price decreases; out is token1.
 *   - oneForZero (token1 in): price increases; out is token0.
 *
 * @param feeTier fee in hundredths of a bip (e.g. 500 = 0.05%).
 */
export function estimateV3AmountOut(
  amountIn: bigint,
  sqrtPriceX96: bigint,
  liquidity: bigint,
  zeroForOne: boolean,
  feeTier: number,
): bigint {
  if (amountIn <= 0n || liquidity <= 0n || sqrtPriceX96 <= 0n) return 0n;

  const feeBig = BigInt(feeTier);
  if (feeBig < 0n || feeBig >= FEE_UNIT) return 0n;

  // Remove the LP fee from the input before it moves the price.
  const amountInLessFee = (amountIn * (FEE_UNIT - feeBig)) / FEE_UNIT;
  if (amountInLessFee === 0n) return 0n;

  if (zeroForOne) {
    // Selling token0 -> price (token1/token0) falls.
    // nextSqrtP = (L * 2^96 * sqrtP) / (L * 2^96 + amountIn * sqrtP)
    const numerator1 = liquidity * Q96;
    const denominator = numerator1 + amountInLessFee * sqrtPriceX96;
    if (denominator === 0n) return 0n;
    const nextSqrtP = (numerator1 * sqrtPriceX96) / denominator;
    if (nextSqrtP >= sqrtPriceX96) return 0n;
    // amountOut (token1) = L * (sqrtP - nextSqrtP) / 2^96
    return (liquidity * (sqrtPriceX96 - nextSqrtP)) / Q96;
  }

  // Selling token1 -> price rises.
  // nextSqrtP = sqrtP + (amountIn * 2^96) / L
  const nextSqrtP = sqrtPriceX96 + (amountInLessFee * Q96) / liquidity;
  if (nextSqrtP <= sqrtPriceX96) return 0n;
  // amountOut (token0) = L * 2^96 * (nextSqrtP - sqrtP) / (nextSqrtP * sqrtP)
  const numerator = liquidity * Q96 * (nextSqrtP - sqrtPriceX96);
  const denominator = nextSqrtP * sqrtPriceX96;
  if (denominator === 0n) return 0n;
  return numerator / denominator;
}

/**
 * Computes a V3 pool address deterministically via CREATE2.
 *
 * Unlike V2, the V3 salt is the abi.encode (not encodePacked) of
 * (token0, token1, fee), matching the UniswapV3Factory deploy logic.
 *
 * Standard fee tiers: 100 (0.01%), 500 (0.05%), 3000 (0.3%), 10000 (1%).
 *
 * Returns a Promise to match the detector's async pool-lookup interface,
 * even though the computation itself is synchronous (no network call): a
 * future implementation could fall back to an on-chain factory.getPool()
 * lookup without changing any caller.
 */
export function computeV3PoolAddress(
  tokenA: string,
  tokenB: string,
  fee: number,
  factoryAddress: string,
): Promise<string> {
  const [token0, token1] = sortTokens(tokenA, tokenB);
  const salt = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'uint24'],
      [token0, token1, fee],
    ),
  );
  const factory = getAddress(factoryAddress);
  // CREATE2: keccak256(0xff ++ factory ++ salt ++ initCodeHash)[12:]
  const hash = keccak256(
    solidityPacked(
      ['bytes1', 'address', 'bytes32', 'bytes32'],
      ['0xff', factory, salt, UNISWAP_V3_POOL_INIT_CODE_HASH],
    ),
  );
  return Promise.resolve(getAddress('0x' + hash.slice(-40)));
}
