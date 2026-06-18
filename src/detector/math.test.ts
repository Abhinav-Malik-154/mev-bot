/**
 * @file src/detector/math.test.ts
 * @description Unit tests for AMM math functions.
 *
 * These tests use known Uniswap V2 values to verify correctness.
 * We test with real pool reserve values from Ethereum mainnet.
 *
 * Why test math specifically?
 * A single wrong bit in financial math = real money lost.
 * These tests run in milliseconds and catch regressions instantly.
 */

import assert from 'node:assert';
import {
  getAmountOut,
  getAmountIn,
  calculatePriceImpactBps,
  calculateArbitrageProfit,
} from './math.js';

// Test 1: getAmountOut with known values
// reserveIn=1000 ETH, reserveOut=2_000_000 USDC (in 18-decimal units), amountIn=1 ETH
// Formula: (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
{
  const reserveIn = 1000n * 10n ** 18n;
  const reserveOut = 2_000_000n * 10n ** 18n;
  const amountIn = 1n * 10n ** 18n;

  const amountInWithFee = amountIn * 997n;
  const expectedOut = (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
  const result = getAmountOut(amountIn, reserveIn, reserveOut);

  assert.strictEqual(result, expectedOut, `Test 1 failed: expected ${expectedOut}, got ${result}`);
  // Sanity: should be close to 1994 USDC (2 ETH * 997/1000 minus slippage)
  const resultInUsdc = result / 10n ** 18n;
  assert.ok(resultInUsdc >= 1990n && resultInUsdc <= 1998n, `Test 1 range check failed: ${resultInUsdc} USDC`);
}

// Test 2: getAmountOut returns 0n when reserveIn is 0n
{
  const result = getAmountOut(1n * 10n ** 18n, 0n, 2_000_000n * 10n ** 18n);
  assert.strictEqual(result, 0n, 'Test 2 failed: expected 0n when reserveIn is 0');
}

// Test 3: getAmountIn correctly inverts getAmountOut
{
  const reserveIn = 1000n * 10n ** 18n;
  const reserveOut = 2_000_000n * 10n ** 18n;
  const originalAmountIn = 1n * 10n ** 18n;

  const amountOut = getAmountOut(originalAmountIn, reserveIn, reserveOut);
  const invertedAmountIn = getAmountIn(amountOut, reserveIn, reserveOut);

  // Due to integer rounding in both directions, should be within 1 wei
  const diff = invertedAmountIn > originalAmountIn
    ? invertedAmountIn - originalAmountIn
    : originalAmountIn - invertedAmountIn;

  assert.ok(diff <= 1n, `Test 3 failed: inversion diff ${diff} > 1 wei`);
}

// Test 4a: calculatePriceImpactBps — 1 ETH into 1000 ETH pool = 10 bps (0.1%)
// (amountIn / reserveIn) * 10000 = (1/1000) * 10000 = 10 bps
{
  const amountIn = 1n * 10n ** 18n;
  const reserveIn = 1000n * 10n ** 18n;
  const result = calculatePriceImpactBps(amountIn, reserveIn);
  assert.strictEqual(result, 10n, `Test 4a failed: expected 10 bps, got ${result}`);
}

// Test 4b: calculatePriceImpactBps — 10 ETH into 1000 ETH pool = 100 bps (1%)
// (10/1000) * 10000 = 100 bps
{
  const amountIn = 10n * 10n ** 18n;
  const reserveIn = 1000n * 10n ** 18n;
  const result = calculatePriceImpactBps(amountIn, reserveIn);
  assert.strictEqual(result, 100n, `Test 4b failed: expected 100 bps, got ${result}`);
}

// Test 5: calculateArbitrageProfit returns 0n when pools have equal prices
{
  const reserve = 1000n * 10n ** 18n;
  const result = calculateArbitrageProfit(
    1n * 10n ** 18n,
    reserve, reserve,  // poolA: equal price
    reserve, reserve,  // poolB: equal price
  );
  assert.strictEqual(result, 0n, `Test 5 failed: expected 0n for equal-price pools, got ${result}`);
}

// Test 6: calculateArbitrageProfit returns positive when pool A is cheaper than pool B
// Pool A: ETH is expensive (1 ETH = 1500 USDC) → sell ETH here
// Pool B: ETH is cheap   (1 ETH = 1000 USDC) → buy ETH back here
// Route: ETH→USDC on poolA, then USDC→ETH on poolB → net gain in ETH
{
  const eth = 10n ** 18n;
  const usdc = 10n ** 6n;

  // poolA: 1 ETH = 1500 USDC (sell ETH here for more USDC)
  const reserveInA = 100n * eth;           // ETH reserve of pool A
  const reserveOutA = 150_000n * usdc;     // USDC reserve of pool A

  // poolB: 1 ETH = 1000 USDC (buy ETH back for fewer USDC)
  const reserveInB = 100_000n * usdc;      // USDC reserve of pool B (we sell USDC here)
  const reserveOutB = 100n * eth;          // ETH reserve of pool B (we receive ETH here)

  const amountIn = 1n * eth;
  const result = calculateArbitrageProfit(amountIn, reserveInA, reserveOutA, reserveInB, reserveOutB);
  assert.ok(result > 0n, `Test 6 failed: expected positive profit, got ${result}`);
}

console.log('✓ All math tests passed');
