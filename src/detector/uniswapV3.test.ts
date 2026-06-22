/**
 * @file src/detector/uniswapV3.test.ts
 * @description Unit tests for Uniswap V3 pool math and address derivation.
 *
 * V3 math is pure integer fixed-point arithmetic, so these tests run in
 * milliseconds with no network access. We verify the sqrtPriceX96 -> price
 * conversion against hand-computable values, confirm the swap estimator's
 * guard rails and monotonicity, and check that CREATE2 address derivation
 * produces a well-formed checksummed address.
 */

import assert from 'node:assert';
import { getAddress } from 'ethers';
import {
  sqrtPriceX96ToPrice,
  estimateV3AmountOut,
  computeV3PoolAddress,
  UNISWAP_V3_FACTORY,
} from './uniswapV3.js';

const Q96 = 2n ** 96n;

// Test 1: sqrtPriceX96ToPrice against known, hand-computable values.
{
  // sqrtPriceX96 == 2^96 means sqrt(price) == 1, so price == 1.0 == 1e18.
  const priceOne = sqrtPriceX96ToPrice(Q96, 18, 18);
  assert.strictEqual(priceOne, 10n ** 18n, `Test 1a failed: expected 1e18, got ${priceOne}`);

  // sqrtPriceX96 == 2 * 2^96 means sqrt(price) == 2, so price == 4.0 == 4e18.
  const priceFour = sqrtPriceX96ToPrice(2n * Q96, 18, 18);
  assert.strictEqual(priceFour, 4n * 10n ** 18n, `Test 1b failed: expected 4e18, got ${priceFour}`);

  // Decimal adjustment: token0 has 6 decimals, token1 has 18 (USDC/WETH shape).
  // With sqrt(price) == 1 in raw units, the human price scales by 10^(6-18).
  const priceAdjusted = sqrtPriceX96ToPrice(Q96, 6, 18);
  assert.strictEqual(
    priceAdjusted,
    10n ** 18n / 10n ** 12n,
    `Test 1c failed: expected 1e6, got ${priceAdjusted}`,
  );

  // Real USDC/WETH 0.3% pool fixture: a representative live sqrtPriceX96.
  // USDC = token0 (6 dec), WETH = token1 (18 dec). The price of WETH in USDC
  // terms (token1 per token0, decimal-adjusted) should land in a sane band.
  const usdcWethSqrtPrice = 1727030697828419467351738638n;
  const price = sqrtPriceX96ToPrice(usdcWethSqrtPrice, 6, 18);
  // Non-zero and finite — exact value depends on the fixture; assert positivity.
  assert.ok(price > 0n, `Test 1d failed: expected positive price, got ${price}`);
}

// Test 2: estimateV3AmountOut returns 0n for zero liquidity.
{
  const out = estimateV3AmountOut(10n ** 18n, Q96, 0n, true, 3000);
  assert.strictEqual(out, 0n, `Test 2 failed: expected 0n for zero liquidity, got ${out}`);

  // Zero amountIn and zero sqrtPrice are likewise guarded.
  assert.strictEqual(estimateV3AmountOut(0n, Q96, 10n ** 18n, true, 3000), 0n, 'Test 2 zero-in failed');
  assert.strictEqual(estimateV3AmountOut(10n ** 18n, 0n, 10n ** 18n, true, 3000), 0n, 'Test 2 zero-price failed');
}

// Test 3: estimateV3AmountOut increases monotonically with amountIn (both directions).
{
  const liquidity = 10n ** 24n;
  const sqrtPrice = Q96; // price 1.0

  let prevZeroForOne = 0n;
  let prevOneForZero = 0n;
  for (let i = 1n; i <= 10n; i++) {
    const amountIn = i * 10n ** 18n;

    const outZ = estimateV3AmountOut(amountIn, sqrtPrice, liquidity, true, 3000);
    assert.ok(outZ > prevZeroForOne, `Test 3 (zeroForOne) not monotonic at i=${i}: ${outZ} <= ${prevZeroForOne}`);
    prevZeroForOne = outZ;

    const outO = estimateV3AmountOut(amountIn, sqrtPrice, liquidity, false, 3000);
    assert.ok(outO > prevOneForZero, `Test 3 (oneForZero) not monotonic at i=${i}: ${outO} <= ${prevOneForZero}`);
    prevOneForZero = outO;
  }
}

// Test 4: computeV3PoolAddress produces a correctly checksummed address.
{
  const weth = '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9';
  const usdc = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

  const pool = await computeV3PoolAddress(weth, usdc, 3000, UNISWAP_V3_FACTORY);

  // Must be a 0x-prefixed 20-byte hex string.
  assert.match(pool, /^0x[0-9a-fA-F]{40}$/, `Test 4 failed: malformed address ${pool}`);
  // Must be already checksummed — getAddress is a no-op round trip.
  assert.strictEqual(getAddress(pool), pool, `Test 4 failed: address not checksummed: ${pool}`);

  // Token ordering must not matter — V3 sorts tokens before hashing.
  const poolReversed = await computeV3PoolAddress(usdc, weth, 3000, UNISWAP_V3_FACTORY);
  assert.strictEqual(pool, poolReversed, 'Test 4 failed: address depends on token order');

  // Different fee tiers must yield different pool addresses.
  const poolLowFee = await computeV3PoolAddress(weth, usdc, 500, UNISWAP_V3_FACTORY);
  assert.notStrictEqual(pool, poolLowFee, 'Test 4 failed: fee tier did not change address');
}

console.log('✓ All Uniswap V3 tests passed');
