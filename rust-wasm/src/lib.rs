use wasm_bindgen::prelude::*;

// Uniswap V2: amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
// All arithmetic uses u128 internally to prevent overflow in intermediate products.
// The WASM boundary uses u64 (wasm-bindgen BigInt) — sufficient for Sepolia testnet amounts.

const FEE_NUMERATOR: u128 = 997;
const FEE_DENOMINATOR: u128 = 1000;
const BASIS_POINTS: u128 = 10_000;
const BINARY_SEARCH_ITERATIONS: u32 = 64;

fn amount_out_inner(amount_in: u128, reserve_in: u128, reserve_out: u128) -> u128 {
    if amount_in == 0 || reserve_in == 0 || reserve_out == 0 {
        return 0;
    }
    let amount_in_with_fee = amount_in * FEE_NUMERATOR;
    let numerator = amount_in_with_fee * reserve_out;
    let denominator = reserve_in * FEE_DENOMINATOR + amount_in_with_fee;
    numerator / denominator
}

fn amount_in_inner(amount_out: u128, reserve_in: u128, reserve_out: u128) -> u128 {
    if amount_out == 0 || reserve_in == 0 || reserve_out == 0 || amount_out >= reserve_out {
        return 0;
    }
    let numerator = reserve_in * amount_out * FEE_DENOMINATOR;
    let denominator = (reserve_out - amount_out) * FEE_NUMERATOR;
    numerator / denominator + 1
}

fn arb_profit_inner(
    amount_in: u128,
    reserve_in_a: u128,
    reserve_out_a: u128,
    reserve_in_b: u128,
    reserve_out_b: u128,
) -> u128 {
    let mid = amount_out_inner(amount_in, reserve_in_a, reserve_out_a);
    if mid == 0 {
        return 0;
    }
    let out = amount_out_inner(mid, reserve_in_b, reserve_out_b);
    if out <= amount_in {
        return 0;
    }
    out - amount_in
}

/// Uniswap V2 getAmountOut: constant-product with 0.3% LP fee.
#[wasm_bindgen]
pub fn get_amount_out(amount_in: u64, reserve_in: u64, reserve_out: u64) -> u64 {
    amount_out_inner(amount_in as u128, reserve_in as u128, reserve_out as u128) as u64
}

/// Inverse of getAmountOut: required input to receive exact output.
#[wasm_bindgen]
pub fn get_amount_in(amount_out: u64, reserve_in: u64, reserve_out: u64) -> u64 {
    amount_in_inner(amount_out as u128, reserve_in as u128, reserve_out as u128) as u64
}

/// Price impact in basis points (1 bp = 0.01%).
#[wasm_bindgen]
pub fn price_impact_bps(amount_in: u64, reserve_in: u64) -> u64 {
    if reserve_in == 0 {
        return 0;
    }
    ((amount_in as u128 * BASIS_POINTS) / reserve_in as u128) as u64
}

/// Net profit from a two-leg arb: buy on pool A, sell on pool B.
/// Returns 0 if unprofitable in either direction.
#[wasm_bindgen]
pub fn arbitrage_profit(
    amount_in: u64,
    reserve_in_a: u64,
    reserve_out_a: u64,
    reserve_in_b: u64,
    reserve_out_b: u64,
) -> u64 {
    arb_profit_inner(
        amount_in as u128,
        reserve_in_a as u128,
        reserve_out_a as u128,
        reserve_in_b as u128,
        reserve_out_b as u128,
    ) as u64
}

/// Result type returned by find_optimal_amount_in.
#[wasm_bindgen]
pub struct OptimalResult {
    pub optimal_amount_in: u64,
    pub expected_profit: u64,
}

/// Binary search (64 iterations) for the amount_in that maximises arb profit.
/// Mirrors src/detector/math.ts findOptimalAmountIn — runs in WASM for lower latency.
#[wasm_bindgen]
pub fn find_optimal_amount_in(
    reserve_in_a: u64,
    reserve_out_a: u64,
    reserve_in_b: u64,
    reserve_out_b: u64,
    max_amount_in: u64,
) -> OptimalResult {
    if max_amount_in == 0 {
        return OptimalResult { optimal_amount_in: 0, expected_profit: 0 };
    }

    let (ra_in, ra_out, rb_in, rb_out) = (
        reserve_in_a as u128,
        reserve_out_a as u128,
        reserve_in_b as u128,
        reserve_out_b as u128,
    );

    let mut lo: u128 = 1;
    let mut hi: u128 = max_amount_in as u128;
    let mut best_amount: u128 = 0;
    let mut best_profit: u128 = 0;

    for _ in 0..BINARY_SEARCH_ITERATIONS {
        if lo >= hi {
            break;
        }
        let mid = (lo + hi) / 2;
        let profit_mid = arb_profit_inner(mid, ra_in, ra_out, rb_in, rb_out);
        let profit_next = arb_profit_inner(mid + 1, ra_in, ra_out, rb_in, rb_out);

        if profit_mid > best_profit {
            best_profit = profit_mid;
            best_amount = mid;
        }

        if profit_next > profit_mid {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }

    OptimalResult {
        optimal_amount_in: best_amount as u64,
        expected_profit: best_profit as u64,
    }
}

/// Quick sanity-check callable from JS: returns true if pool prices differ enough to arb.
/// threshold_bps: minimum price difference in basis points (e.g. 30 = 0.3%).
#[wasm_bindgen]
pub fn is_arbitrageable(
    reserve_in_a: u64,
    reserve_out_a: u64,
    reserve_in_b: u64,
    reserve_out_b: u64,
    threshold_bps: u64,
) -> bool {
    if reserve_in_a == 0 || reserve_out_a == 0 || reserve_in_b == 0 || reserve_out_b == 0 {
        return false;
    }
    // price_a = reserveOut_a / reserveIn_a  (scaled by 1e18 to stay integer)
    let price_a = (reserve_out_a as u128 * 1_000_000_000_000_000_000u128) / reserve_in_a as u128;
    let price_b = (reserve_out_b as u128 * 1_000_000_000_000_000_000u128) / reserve_in_b as u128;
    let (lo, hi) = if price_a < price_b { (price_a, price_b) } else { (price_b, price_a) };
    let diff_bps = ((hi - lo) * BASIS_POINTS) / lo;
    diff_bps >= threshold_bps as u128
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tests use gwei scale (1e9) so that reserve * 1000 stays within u64.
    // 1 unit = 1 gwei; reserve of 100 units = 100 gwei pool (small but correct math).
    const UNIT: u64 = 1_000_000_000; // 1 gwei expressed in wei

    #[test]
    fn test_amount_out_zero_guards() {
        assert_eq!(get_amount_out(0, UNIT * 100, UNIT * 100), 0);
        assert_eq!(get_amount_out(UNIT, 0, UNIT * 100), 0);
        assert_eq!(get_amount_out(UNIT, UNIT * 100, 0), 0);
    }

    #[test]
    fn test_amount_out_fee() {
        // 1 UNIT in, 100 UNIT / 100 UNIT pool — output less than input due to fee + slippage
        let out = get_amount_out(UNIT, UNIT * 100, UNIT * 100);
        assert!(out > 0 && out < UNIT, "out={out}");
        // ≈ 0.9871 UNIT; must be > 98% of UNIT
        assert!(out > UNIT * 98 / 100, "out too small: {out}");
    }

    #[test]
    fn test_amount_in_roundtrip() {
        let reserve = UNIT * 1000;
        let amount_in: u64 = UNIT / 10;
        let out = get_amount_out(amount_in, reserve, reserve);
        let back_in = get_amount_in(out, reserve, reserve);
        // Round-trip within 1 unit (integer division rounding)
        assert!(back_in >= amount_in && back_in <= amount_in + 1, "back_in={back_in}");
    }

    #[test]
    fn test_price_impact_bps() {
        // 1% of reserve → 100 bps
        let bps = price_impact_bps(UNIT, UNIT * 100);
        assert_eq!(bps, 100);
    }

    #[test]
    fn test_arbitrage_profit_unprofitable() {
        // Equal pools → no profit
        let r = UNIT * 1000;
        let profit = arbitrage_profit(UNIT, r, r, r, r);
        assert_eq!(profit, 0);
    }

    #[test]
    fn test_arbitrage_profit_skewed_pools() {
        // Pool A: 1000/1000 (price 1:1), Pool B: 2000/500 (ETH expensive relative to token)
        let r_in_a = UNIT * 1000;
        let r_out_a = UNIT * 1000;
        let r_in_b = UNIT * 2000;
        let r_out_b = UNIT * 500;
        // Buying token on A and selling on B — B has worse token price so no profit
        let profit = arbitrage_profit(UNIT, r_in_a, r_out_a, r_in_b, r_out_b);
        assert_eq!(profit, 0);
    }

    #[test]
    fn test_find_optimal_zero_max() {
        let result = find_optimal_amount_in(0, 0, 0, 0, 0);
        assert_eq!(result.optimal_amount_in, 0);
        assert_eq!(result.expected_profit, 0);
    }

    #[test]
    fn test_is_arbitrageable_same_pools() {
        let r = UNIT * 1000;
        assert!(!is_arbitrageable(r, r, r, r, 30));
    }

    #[test]
    fn test_is_arbitrageable_skewed_pool() {
        let r = UNIT * 1000;
        // Pool B output reserve 10% higher → price difference > 30 bps
        let r2_out = UNIT * 1100;
        assert!(is_arbitrageable(r, r, r, r2_out, 30));
    }
}
