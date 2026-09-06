/* tslint:disable */
/* eslint-disable */

/**
 * Net profit of a two-leg arbitrage: swap `amount_in` through pool A
 * (in → out), then route the proceeds through pool B (in → out), and
 * compare the final amount against the original `amount_in`.
 *
 * Returns a **signed** `i64`: positive when the round trip is profitable,
 * negative when fees/slippage make it a loss. Callers use the sign to
 * decide whether an opportunity is worth pursuing.
 */
export function calculate_arbitrage_profit(amount_in: bigint, reserve_in_a: bigint, reserve_out_a: bigint, reserve_in_b: bigint, reserve_out_b: bigint): bigint;

/**
 * Price impact of a swap, expressed in basis points (1 bp = 0.01%).
 *
 * `(amount_in * 10_000) / reserve_in`. Returns 0 when `reserve_in` is 0.
 */
export function calculate_price_impact_bps(amount_in: bigint, reserve_in: bigint): bigint;

/**
 * Uniswap V2 `getAmountOut`: constant-product swap with the 0.3% LP fee.
 *
 * Returns 0 if `reserve_in` or `reserve_out` is 0 (degenerate / empty pool),
 * matching the guard in the TypeScript implementation.
 *
 * The result is cast back to `u64`. This is safe for realistic pool sizes:
 * the output is always strictly less than `reserve_out` (you can never
 * receive more than the pool holds), and `reserve_out` itself entered as a
 * `u64`, so the result fits in `u64` by construction.
 */
export function get_amount_out(amount_in: bigint, reserve_in: bigint, reserve_out: bigint): bigint;
