/**
 * @file src/detector/math.ts
 * @description AMM constant product formula mathematics.
 *
 * All Uniswap V2 pools follow the invariant: x * y = k
 * where x and y are the reserves of the two tokens.
 *
 * When someone swaps amountIn of tokenA for tokenB:
 *   amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
 *
 * The 997/1000 factor accounts for the 0.3% LP fee.
 *
 * All calculations use bigint to prevent precision loss.
 * Never use floating point for financial calculations.
 *
 * Why bigint and not a library like decimal.js?
 * bigint is native, zero-dependency, and fast enough.
 * The Uniswap V2 contracts themselves use integer math.
 */

export const UNISWAP_V2_FEE_NUMERATOR = 997n;
export const UNISWAP_V2_FEE_DENOMINATOR = 1000n;
export const BASIS_POINTS = 10000n;

/**
 * Calculates output amount for a Uniswap V2 swap.
 * Applies the 0.3% LP fee (997/1000 factor).
 * Returns 0n if reserves are zero or amountIn is zero.
 */
export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n;
  const amountInWithFee = amountIn * UNISWAP_V2_FEE_NUMERATOR;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * UNISWAP_V2_FEE_DENOMINATOR + amountInWithFee;
  return numerator / denominator;
}

/**
 * Calculates input amount required to get exact output.
 * Inverse of getAmountOut.
 * Returns 0n if reserves are zero or amountOut >= reserveOut.
 */
export function getAmountIn(
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  if (amountOut === 0n || reserveIn === 0n || reserveOut === 0n) return 0n;
  if (amountOut >= reserveOut) return 0n;
  const numerator = reserveIn * amountOut * UNISWAP_V2_FEE_DENOMINATOR;
  const denominator = (reserveOut - amountOut) * UNISWAP_V2_FEE_NUMERATOR;
  return numerator / denominator + 1n;
}

/**
 * Calculates price impact of a swap as basis points (1 bp = 0.01%).
 * Price impact = how much the swap moves the pool price.
 * High price impact = large opportunity for arbitrageur.
 * Formula: (amountIn * BASIS_POINTS) / reserveIn
 */
export function calculatePriceImpactBps(
  amountIn: bigint,
  reserveIn: bigint,
): bigint {
  if (reserveIn === 0n) return 0n;
  return (amountIn * BASIS_POINTS) / reserveIn;
}

/**
 * Calculates arbitrage profit given two pools with different prices.
 * We buy cheap on poolA and sell expensive on poolB (or vice versa).
 * Returns net profit in tokenB after accounting for both swaps.
 * Returns 0n if no profitable direction exists.
 */
export function calculateArbitrageProfit(
  amountIn: bigint,
  reserveInA: bigint,
  reserveOutA: bigint,
  reserveInB: bigint,
  reserveOutB: bigint,
): bigint {
  // Direction A→B on poolA, then B→A on poolB
  const midAmount = getAmountOut(amountIn, reserveInA, reserveOutA);
  if (midAmount === 0n) return 0n;
  const finalAmount = getAmountOut(midAmount, reserveInB, reserveOutB);
  if (finalAmount <= amountIn) return 0n;
  return finalAmount - amountIn;
}

/**
 * Finds the optimal input amount that maximizes arbitrage profit.
 * Uses binary search between minAmount and maxAmount.
 * Returns optimal amountIn and expected profit.
 */
export function findOptimalAmountIn(
  reserveInA: bigint,
  reserveOutA: bigint,
  reserveInB: bigint,
  reserveOutB: bigint,
  maxAmountIn: bigint,
): { optimalAmountIn: bigint; expectedProfit: bigint } {
  if (maxAmountIn === 0n) return { optimalAmountIn: 0n, expectedProfit: 0n };

  let lo = 1n;
  let hi = maxAmountIn;
  let bestAmount = 0n;
  let bestProfit = 0n;

  // 64 iterations of binary search gives sub-wei precision on mainnet amounts
  for (let i = 0; i < 64; i++) {
    if (lo >= hi) break;
    const mid = (lo + hi) / 2n;
    const profitMid = calculateArbitrageProfit(mid, reserveInA, reserveOutA, reserveInB, reserveOutB);
    const profitMidPlus1 = calculateArbitrageProfit(mid + 1n, reserveInA, reserveOutA, reserveInB, reserveOutB);

    if (profitMid > bestProfit) {
      bestProfit = profitMid;
      bestAmount = mid;
    }

    if (profitMidPlus1 > profitMid) {
      lo = mid + 1n;
    } else {
      hi = mid;
    }
  }

  return { optimalAmountIn: bestAmount, expectedProfit: bestProfit };
}

/**
 * Converts wei to ETH string with specified decimal places.
 * Used for logging only — never for calculations.
 */
export function formatEthAmount(wei: bigint, decimals: number): string {
  const divisor = 10n ** 18n;
  const whole = wei / divisor;
  const remainder = wei % divisor;
  const remainderStr = remainder.toString().padStart(18, '0').slice(0, decimals);
  return `${whole.toString()}.${remainderStr}`;
}
