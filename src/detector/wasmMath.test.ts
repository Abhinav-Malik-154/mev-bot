/**
 * @file src/detector/wasmMath.test.ts
 * @description Differential tests: Rust/WASM AMM math vs the pure-TS math.
 *
 * The WASM module is only useful if it is bit-for-bit identical to
 * math.ts — it feeds a pre-filter that decides whether an opportunity is
 * worth pricing precisely, so a wrong answer silently drops real money.
 *
 * These tests exist because the Rust implementation once computed its
 * numerator as `amount_in * 997 * reserve_out` in u128, which overflows
 * at wei scale (1 ETH in against a 0.34 ETH reserve is already past the
 * u128 ceiling). A release build wraps silently, so `getAmountOut(3e18,
 * 1e18, 2e18)` returned 49411115596102761 instead of 1498872463041844149
 * — ~30x low, with no error raised anywhere.
 *
 * The Rust unit tests missed it because they ran at gwei scale (1e9),
 * keeping the numerator ~14 orders of magnitude below the overflow point.
 * Everything here therefore runs at **wei scale**, the scale production uses.
 */

import assert from 'node:assert';
import {
  loadWasmMath,
  getAmountOutWasm,
  calculatePriceImpactBpsWasm,
  calculateArbitrageProfitWasm,
} from './wasmMath.js';
import { getAmountOut, calculatePriceImpactBps, calculateArbitrageProfit } from './math.js';

const ETH = 10n ** 18n;
const U64_MAX = 2n ** 64n - 1n;

const loaded = await loadWasmMath();
assert.strictEqual(loaded, true, 'WASM module failed to load — run wasm-pack build in rust/amm-math');

// Test 1: the exact regression case that the u128 overflow got wrong.
{
  const out = getAmountOutWasm(3n * ETH, ETH, 2n * ETH);
  assert.strictEqual(
    out,
    1_498_872_463_041_844_149n,
    `overflow regression: getAmountOut(3e18, 1e18, 2e18) returned ${out}`,
  );
  assert.strictEqual(out, getAmountOut(3n * ETH, ETH, 2n * ETH), 'WASM disagrees with TS');
}

// Test 2: differential grid at wei scale. Every combination stays inside the
// u64 boundary the WASM ABI accepts (u64::MAX is only ~18.4 ETH in wei), which
// is exactly the range where the old numerator overflowed.
{
  const amounts = [1n, 10n ** 9n, ETH / 1000n, ETH / 10n, ETH, 3n * ETH, 9n * ETH];
  const reserves = [ETH / 100n, ETH, 2n * ETH, 10n * ETH, 18n * ETH, U64_MAX];

  let checked = 0;
  for (const amountIn of amounts) {
    for (const reserveIn of reserves) {
      for (const reserveOut of reserves) {
        const wasm = getAmountOutWasm(amountIn, reserveIn, reserveOut);
        const ts = getAmountOut(amountIn, reserveIn, reserveOut);
        assert.strictEqual(
          wasm,
          ts,
          `getAmountOut mismatch at (${amountIn}, ${reserveIn}, ${reserveOut}): wasm=${wasm} ts=${ts}`,
        );
        // The cast back to u64 in Rust is only sound while this holds.
        assert.ok(wasm < reserveOut, `output ${wasm} >= reserveOut ${reserveOut}`);
        checked++;
      }
      const wasmBps = calculatePriceImpactBpsWasm(amountIn, reserveIn);
      assert.strictEqual(
        wasmBps,
        calculatePriceImpactBps(amountIn, reserveIn),
        `priceImpact mismatch at (${amountIn}, ${reserveIn})`,
      );
    }
  }
  assert.ok(checked >= 200, `expected a broad grid, only checked ${checked}`);
}

// Test 3: two-leg arbitrage profit agrees, both profitable and losing.
{
  const profitable: [bigint, bigint, bigint, bigint, bigint] = [
    ETH / 10n,
    10n * ETH,
    10n * ETH,
    5n * ETH,
    15n * ETH,
  ];
  const losing: [bigint, bigint, bigint, bigint, bigint] = [
    ETH / 10n,
    10n * ETH,
    10n * ETH,
    10n * ETH,
    10n * ETH,
  ];

  for (const args of [profitable, losing]) {
    assert.strictEqual(
      calculateArbitrageProfitWasm(...args),
      calculateArbitrageProfit(...args),
      `arbitrage profit mismatch for ${args.join(', ')}`,
    );
  }
  assert.ok(calculateArbitrageProfitWasm(...profitable) > 0n, 'expected a profitable round trip');
  // Clamped to 0n, not negative: the binding mirrors math.ts, whose contract
  // is "0n when no profitable direction exists". The Rust export underneath
  // is signed, so this asserts the binding actually applies the clamp.
  assert.strictEqual(
    calculateArbitrageProfitWasm(...losing),
    0n,
    'losing round trip must clamp to 0n to match math.ts',
  );
}

// Test 4: values past the u64 ABI ceiling must throw, never truncate.
// This is the guard that keeps the pre-filter failing open instead of
// silently comparing garbage.
{
  assert.throws(
    () => getAmountOutWasm(ETH, U64_MAX + 1n, ETH),
    RangeError,
    'expected RangeError above the u64 ceiling',
  );
  assert.throws(() => getAmountOutWasm(-1n, ETH, ETH), RangeError, 'expected RangeError for negative');
}

// eslint-disable-next-line no-console -- test runner output
console.log('✓ All WASM/TS differential tests passed');
