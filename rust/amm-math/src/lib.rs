//! AMM constant-product math, compiled to WASM.
//!
//! Mirrors the logic in `src/detector/math.ts` exactly — same formula,
//! same fee constants — but runs with zero garbage collection,
//! eliminating GC pause risk on the bot's hottest code path.
//!
//! `u128` is used for all intermediate arithmetic because `amount_in * 997`
//! can exceed `u64` range for large pools; `u128` has ample headroom
//! (~3.4 * 10^38) without needing an arbitrary-precision library.
//!
//! ## Why the WASM boundary is `u64`
//! `wasm-bindgen` marshals `u64`/`i64` as JavaScript `BigInt`, so no
//! precision is lost crossing the boundary. The practical ceiling is
//! `u64::MAX` ≈ 1.8 * 10^19 wei (~18.4 ETH worth of wei). Every realistic
//! ETH/token reserve and swap amount in wei fits comfortably below this,
//! and the TypeScript binding (`src/detector/wasmMath.ts`) enforces the
//! ceiling explicitly before calling in. Internally we widen to `u128`
//! so the intermediate products never overflow.

use wasm_bindgen::prelude::*;

/// Uniswap V2 charges a 0.3% LP fee, encoded as the ratio 997/1000.
const FEE_NUMERATOR: u128 = 997;
const FEE_DENOMINATOR: u128 = 1000;
/// 1 basis point = 0.01%; 10_000 bps = 100%.
const BASIS_POINTS: u128 = 10_000;

/// Internal `u128` implementation of the constant-product swap formula.
/// Kept private so both the WASM export and the arbitrage helper share
/// one source of truth for the math.
fn amount_out_inner(amount_in: u128, reserve_in: u128, reserve_out: u128) -> u128 {
    if amount_in == 0 || reserve_in == 0 || reserve_out == 0 {
        return 0;
    }
    let amount_in_with_fee = amount_in * FEE_NUMERATOR;
    let numerator = amount_in_with_fee * reserve_out;
    let denominator = reserve_in * FEE_DENOMINATOR + amount_in_with_fee;
    numerator / denominator
}

/// Uniswap V2 `getAmountOut`: constant-product swap with the 0.3% LP fee.
///
/// Returns 0 if `reserve_in` or `reserve_out` is 0 (degenerate / empty pool),
/// matching the guard in the TypeScript implementation.
///
/// The result is cast back to `u64`. This is safe for realistic pool sizes:
/// the output is always strictly less than `reserve_out` (you can never
/// receive more than the pool holds), and `reserve_out` itself entered as a
/// `u64`, so the result fits in `u64` by construction.
#[wasm_bindgen]
pub fn get_amount_out(amount_in: u64, reserve_in: u64, reserve_out: u64) -> u64 {
    amount_out_inner(amount_in as u128, reserve_in as u128, reserve_out as u128) as u64
}

/// Price impact of a swap, expressed in basis points (1 bp = 0.01%).
///
/// `(amount_in * 10_000) / reserve_in`. Returns 0 when `reserve_in` is 0.
#[wasm_bindgen]
pub fn calculate_price_impact_bps(amount_in: u64, reserve_in: u64) -> u64 {
    if reserve_in == 0 {
        return 0;
    }
    ((amount_in as u128 * BASIS_POINTS) / reserve_in as u128) as u64
}

/// Net profit of a two-leg arbitrage: swap `amount_in` through pool A
/// (in → out), then route the proceeds through pool B (in → out), and
/// compare the final amount against the original `amount_in`.
///
/// Returns a **signed** `i64`: positive when the round trip is profitable,
/// negative when fees/slippage make it a loss. Callers use the sign to
/// decide whether an opportunity is worth pursuing.
#[wasm_bindgen]
pub fn calculate_arbitrage_profit(
    amount_in: u64,
    reserve_in_a: u64,
    reserve_out_a: u64,
    reserve_in_b: u64,
    reserve_out_b: u64,
) -> i64 {
    let mid = amount_out_inner(amount_in as u128, reserve_in_a as u128, reserve_out_a as u128);
    if mid == 0 {
        return -(amount_in as i64);
    }
    let out = amount_out_inner(mid, reserve_in_b as u128, reserve_out_b as u128);
    // Both `out` and `amount_in` originated as u64, so each fits in i64.
    out as i64 - amount_in as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tests use a gwei scale (1e9) so that `reserve * 1000` stays within u64
    // while still exercising the exact integer math used in production.
    const UNIT: u64 = 1_000_000_000; // 1 gwei expressed in wei

    #[test]
    fn test_get_amount_out_matches_known_value() {
        // reserveIn = reserveOut = 1000 UNIT, amountIn = 1 UNIT.
        // Hand-computed: (1e9 * 997 * 1000e9) / (1000e9 * 1000 + 1e9 * 997)
        //              = 9.97e23 / 1.000000997e15 ≈ 996_006_980 wei.
        let reserve = UNIT * 1000;
        let out = get_amount_out(UNIT, reserve, reserve);
        let amount_in_with_fee = UNIT as u128 * 997;
        let expected =
            ((amount_in_with_fee * reserve as u128) / (reserve as u128 * 1000 + amount_in_with_fee)) as u64;
        assert_eq!(out, expected, "out={out} expected={expected}");
        // Sanity band: just under 1 UNIT after fee + slippage.
        assert!(out > UNIT * 99 / 100 && out < UNIT, "out out of band: {out}");
    }

    #[test]
    fn test_get_amount_out_zero_reserve_returns_zero() {
        assert_eq!(get_amount_out(UNIT, 0, UNIT * 100), 0);
        assert_eq!(get_amount_out(UNIT, UNIT * 100, 0), 0);
        assert_eq!(get_amount_out(0, UNIT * 100, UNIT * 100), 0);
    }

    #[test]
    fn test_price_impact_calculation() {
        // 1 UNIT against a 100 UNIT reserve = 1% = 100 bps.
        assert_eq!(calculate_price_impact_bps(UNIT, UNIT * 100), 100);
        // Zero-reserve guard.
        assert_eq!(calculate_price_impact_bps(UNIT, 0), 0);
    }

    #[test]
    fn test_arbitrage_profit_positive_case() {
        // Pool A is balanced 1:1; Pool B prices the return token richly,
        // so buying on A and selling on B nets a profit.
        // A: in=1000 UNIT, out=1000 UNIT.  B: in=500 UNIT, out=1000 UNIT.
        let profit = calculate_arbitrage_profit(
            UNIT,
            UNIT * 1000,
            UNIT * 1000,
            UNIT * 500,
            UNIT * 1000,
        );
        assert!(profit > 0, "expected positive profit, got {profit}");
    }

    #[test]
    fn test_arbitrage_profit_negative_case() {
        // Identical balanced pools: two 0.3% fees with no price spread
        // guarantee a loss equal to the fees + slippage.
        let r = UNIT * 1000;
        let profit = calculate_arbitrage_profit(UNIT, r, r, r, r);
        assert!(profit < 0, "expected negative profit, got {profit}");
    }
}
