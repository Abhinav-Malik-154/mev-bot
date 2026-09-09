//! AMM constant-product math, compiled to WASM.
//!
//! Mirrors the logic in `src/detector/math.ts` exactly — same formula,
//! same fee constants — but runs with zero garbage collection,
//! eliminating GC pause risk on the bot's hottest code path.
//!
//! ## Why the WASM boundary is `u64`
//! `wasm-bindgen` marshals `u64`/`i64` as JavaScript `BigInt`, so no
//! precision is lost crossing the boundary. The practical ceiling is
//! `u64::MAX` ≈ 1.8 * 10^19 wei (~18.4 ETH worth of wei). Every realistic
//! ETH/token reserve and swap amount in wei fits comfortably below this,
//! and the TypeScript binding (`src/detector/wasmMath.ts`) enforces the
//! ceiling explicitly before calling in.
//!
//! ## Why `u128` alone is not enough
//! The swap numerator is `amount_in * 997 * reserve_out`. With `u64` inputs
//! that product needs up to ~138 bits, which overflows `u128` (128 bits,
//! max ~3.4 * 10^38). At wei scale this is reached almost immediately —
//! 1 ETH in against a reserve of only 0.34 ETH already exceeds it — and a
//! release build wraps silently rather than panicking, returning a plausible
//! but badly wrong number. All multiply-then-divide steps therefore go
//! through [`mul_div`], which is exact over the whole `u64` input domain.
//! `overflow-checks` is also enabled for release builds so that any future
//! arithmetic mistake traps loudly instead of corrupting a money value.

use wasm_bindgen::prelude::*;

/// Uniswap V2 charges a 0.3% LP fee, encoded as the ratio 997/1000.
const FEE_NUMERATOR: u128 = 997;
const FEE_DENOMINATOR: u128 = 1000;
/// 1 basis point = 0.01%; 10_000 bps = 100%.
const BASIS_POINTS: u128 = 10_000;

/// Computes `floor((a * b) / d)` exactly, even when `a * b` would overflow
/// `u128`.
///
/// `b` is split into 32-bit halves so the intermediate products stay inside
/// `u128`, and the remainder of the high half is carried into the low half so
/// the result is exact rather than the sum of two truncated quotients:
///
/// ```text
/// a*b = a*hi*2^32 + a*lo
///     = (q*d + r)*2^32 + a*lo          where q = a*hi/d, r = a*hi%d
/// (a*b)/d = q*2^32 + (r*2^32 + a*lo)/d
/// ```
///
/// # Preconditions
/// - `d > a` and `d > 0`. Both hold for every call site here: the denominator
///   is `reserve_in * 1000 + amount_in_with_fee`, which strictly exceeds
///   `amount_in_with_fee` whenever `reserve_in >= 1` (callers guard the zero
///   case). This bound is what keeps `q << 32` inside `u128`.
/// - `b <= u64::MAX`, so `hi` fits in 32 bits.
///
/// Under those bounds every intermediate stays below 2^108 and the result is
/// strictly less than `b`.
fn mul_div(a: u128, b: u128, d: u128) -> u128 {
    debug_assert!(d > a, "mul_div requires d > a to keep the quotient bounded");
    let hi = b >> 32;
    let lo = b & 0xFFFF_FFFF;

    let head = a * hi;
    let q_head = head / d;
    let r_head = head % d;

    let tail = (r_head << 32) + a * lo;
    (q_head << 32) + tail / d
}

/// Internal `u128` implementation of the constant-product swap formula.
/// Kept private so both the WASM export and the arbitrage helper share
/// one source of truth for the math.
fn amount_out_inner(amount_in: u128, reserve_in: u128, reserve_out: u128) -> u128 {
    if amount_in == 0 || reserve_in == 0 || reserve_out == 0 {
        return 0;
    }
    let amount_in_with_fee = amount_in * FEE_NUMERATOR;
    let denominator = reserve_in * FEE_DENOMINATOR + amount_in_with_fee;
    // denominator > amount_in_with_fee because reserve_in >= 1, satisfying
    // mul_div's precondition.
    mul_div(amount_in_with_fee, reserve_out, denominator)
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
///
/// No `mul_div` needed here: `amount_in * 10_000` is at most ~2^78, well
/// inside `u128`.
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
    let mid = amount_out_inner(
        amount_in as u128,
        reserve_in_a as u128,
        reserve_out_a as u128,
    );
    if mid == 0 {
        return -(amount_in as i64);
    }
    // `mid` is strictly less than `reserve_out_a`, which entered as a u64, so
    // it is a valid u64-ranged input for the second leg.
    let out = amount_out_inner(mid, reserve_in_b as u128, reserve_out_b as u128);
    // Both `out` and `amount_in` originated as u64, so each fits in i64.
    out as i64 - amount_in as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    const U64_MAX: u64 = u64::MAX;
    const ETH: u64 = 1_000_000_000_000_000_000; // 1e18 wei

    /// (amount_in, reserve_in, reserve_out, expected_out), all at **wei
    /// scale** — the scale production actually runs at. Expected values were
    /// computed independently with arbitrary-precision integers.
    ///
    /// Before the `mul_div` fix, every one of these overflowed the `u128`
    /// numerator and returned a silently wrapped, badly wrong result: the
    /// first vector returned 49_411_115_596_102_761 instead of
    /// 1_498_872_463_041_844_149 — roughly 30x too small.
    const WEI_VECTORS: &[(u64, u64, u64, u64)] = &[
        (3 * ETH, ETH, 2 * ETH, 1_498_872_463_041_844_149),
        (ETH, 10 * ETH, 10 * ETH, 906_610_893_880_149_131),
        (
            ETH / 10,
            ETH,
            12_345_000_000_000_000_000,
            1_119_211_148_495_044_102,
        ),
        (
            3 * ETH,
            ETH,
            12_345_000_000_000_000_000,
            9_251_790_278_125_783_011,
        ),
        (U64_MAX, U64_MAX, U64_MAX, 9_209_516_195_036_766_630),
        (1, U64_MAX, U64_MAX, 0),
    ];

    #[test]
    fn test_get_amount_out_exact_at_wei_scale() {
        for &(amount_in, reserve_in, reserve_out, expected) in WEI_VECTORS {
            let out = get_amount_out(amount_in, reserve_in, reserve_out);
            assert_eq!(
                out, expected,
                "get_amount_out({amount_in}, {reserve_in}, {reserve_out}) = {out}, want {expected}"
            );
        }
    }

    /// The invariant that makes the `as u64` cast in `get_amount_out` sound:
    /// you can never receive more than the pool holds. A wrapped numerator
    /// can violate this, so assert it across the full u64 boundary.
    #[test]
    fn test_output_never_exceeds_reserve_out() {
        let samples = [1u64, 1_000, ETH / 1000, ETH, 3 * ETH, U64_MAX / 2, U64_MAX];
        for &amount_in in &samples {
            for &reserve_in in &samples {
                for &reserve_out in &samples {
                    let out = get_amount_out(amount_in, reserve_in, reserve_out);
                    assert!(
                        out < reserve_out || reserve_out == 0,
                        "out={out} >= reserve_out={reserve_out} for amount_in={amount_in}, reserve_in={reserve_in}"
                    );
                }
            }
        }
    }

    /// More input must never yield less output on the same pool.
    #[test]
    fn test_monotonic_in_amount_in() {
        let reserve_in = 7 * ETH;
        let reserve_out = 11 * ETH;
        let mut previous = 0u64;
        let mut amount_in = ETH / 1000;
        while amount_in < 5 * ETH {
            let out = get_amount_out(amount_in, reserve_in, reserve_out);
            assert!(out >= previous, "non-monotonic at amount_in={amount_in}");
            previous = out;
            amount_in += ETH / 10;
        }
    }

    #[test]
    fn test_mul_div_matches_plain_division_when_no_overflow() {
        // Small values where `a * b` fits in u128 comfortably, so the naive
        // expression is a valid oracle for mul_div.
        for &(a, b, d) in &[
            (997u128, 1_000u128, 1_000_000u128),
            (12_345, 678, 999_999),
            (1, 1, 2),
        ] {
            assert_eq!(mul_div(a, b, d), (a * b) / d, "mul_div({a}, {b}, {d})");
        }
    }

    #[test]
    fn test_get_amount_out_zero_reserve_returns_zero() {
        // 10 * ETH, not 100: u64::MAX is ~18.4 ETH, so 100 ETH is not a
        // representable input at this boundary.
        assert_eq!(get_amount_out(ETH, 0, 10 * ETH), 0);
        assert_eq!(get_amount_out(ETH, 10 * ETH, 0), 0);
        assert_eq!(get_amount_out(0, 10 * ETH, 10 * ETH), 0);
    }

    #[test]
    fn test_price_impact_calculation() {
        // 1 ETH against a 100 ETH reserve = 1% = 100 bps.
        assert_eq!(calculate_price_impact_bps(ETH / 10, 10 * ETH), 100);
        // Zero-reserve guard.
        assert_eq!(calculate_price_impact_bps(ETH, 0), 0);
        // Boundary: must not overflow at max reserve.
        assert_eq!(calculate_price_impact_bps(U64_MAX, U64_MAX), 10_000);
    }

    #[test]
    fn test_arbitrage_profit_positive_case() {
        // Pool A is balanced 1:1; Pool B prices the return token richly,
        // so buying on A and selling on B nets a profit. Wei scale.
        let profit = calculate_arbitrage_profit(ETH / 10, 10 * ETH, 10 * ETH, 5 * ETH, 15 * ETH);
        assert!(profit > 0, "expected positive profit, got {profit}");
    }

    #[test]
    fn test_arbitrage_profit_negative_case() {
        // Identical balanced pools: two 0.3% fees with no price spread
        // guarantee a loss equal to the fees + slippage.
        let r = 10 * ETH;
        let profit = calculate_arbitrage_profit(ETH / 10, r, r, r, r);
        assert!(profit < 0, "expected negative profit, got {profit}");
    }
}
