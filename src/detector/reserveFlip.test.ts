/**
 * @file src/detector/reserveFlip.test.ts
 * @description Invariant test for the pool-B reserve-flip bug.
 *
 * Two pools with IDENTICAL prices (same reserves) can never yield arbitrage
 * profit — a round trip merely pays the 0.3% fee twice. The old code fed the
 * intermediate-token amount into the base-token reserve of the return-leg pool
 * (a DAI amount into the WETH side), fabricating an impossible profit.
 *
 * Test 1 documents the orientation at the math layer (flipped vs. unflipped).
 * Test 2 is the real invariant: it drives detectArbitrageOpportunity() against
 * a stub provider returning identical reserves for both the primary and the
 * alternative pool. It FAILS on the buggy call sites (returns a huge-profit
 * opportunity) and PASSES after the reserve-flip fix (returns null).
 */

import assert from 'node:assert';
import { AbiCoder } from 'ethers';
import type { JsonRpcProvider } from 'ethers';
import { detectArbitrageOpportunity } from './arbitrage.js';
import { calculateArbitrageProfit } from './math.js';
import type { UniswapV2Swap } from '../types/index.js';

const coder = AbiCoder.defaultAbiCoder();

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

// Uniswap V2 pair function selectors.
const SEL_GET_RESERVES = '0x0902f1ac';
const SEL_TOKEN0 = '0x0dfe1681';
const SEL_TOKEN1 = '0xd21220a7';

// DAI < WETH by address, so DAI is token0 and WETH is token1.
// A realistic asymmetric pool: 200,000 DAI : 100 WETH (≈ 2000 DAI/WETH).
// Asymmetry is what exposes the bug — a symmetric 1:1 pool would hide it.
const RESERVE_DAI = 200_000n * 10n ** 18n; // token0 reserve
const RESERVE_WETH = 100n * 10n ** 18n; // token1 reserve

// Minimal ethers-v6 ContractRunner: only .call is needed for view calls.
// Returns the SAME reserves for every pool address, so the primary (Uniswap)
// and alternative (SushiSwap) pools have identical prices.
const fakeProvider = {
  // Not `async`: the body is synchronous, and `async` with no `await` trips
  // @typescript-eslint/require-await. ethers only needs a thenable back, so
  // resolve explicitly and keep the same Promise<string> contract.
  call: (tx: { data?: string }): Promise<string> => {
    const sel = (tx.data ?? '').slice(0, 10);
    if (sel === SEL_GET_RESERVES) {
      return Promise.resolve(
        coder.encode(['uint112', 'uint112', 'uint32'], [RESERVE_DAI, RESERVE_WETH, 0]),
      );
    }
    if (sel === SEL_TOKEN0) return Promise.resolve(coder.encode(['address'], [DAI]));
    if (sel === SEL_TOKEN1) return Promise.resolve(coder.encode(['address'], [WETH]));
    return Promise.reject(new Error(`unexpected selector ${sel}`));
  },
};

// ── Test 1: orientation at the math layer ────────────────────────────────────
{
  const amountIn = 1n * 10n ** 18n; // 1 WETH

  // Correct: WETH->DAI on pool A (WETH-in / DAI-out), then DAI->WETH on pool B
  // (DAI-in / WETH-out — pool B FLIPPED). Identical pools → exactly 0.
  const correct = calculateArbitrageProfit(
    amountIn,
    RESERVE_WETH, RESERVE_DAI, // pool A: WETH-in, DAI-out
    RESERVE_DAI, RESERVE_WETH, // pool B: DAI-in,  WETH-out (flipped)
  );
  assert.strictEqual(correct, 0n, `Test 1a failed: expected 0n for identical pools (flipped), got ${correct}`);

  // Buggy: pool B left UNFLIPPED (WETH-in / DAI-out) — feeds a DAI amount into
  // the WETH reserve. Demonstrates the impossible profit the fix removes.
  const buggy = calculateArbitrageProfit(
    amountIn,
    RESERVE_WETH, RESERVE_DAI, // pool A
    RESERVE_WETH, RESERVE_DAI, // pool B NOT flipped (the bug)
  );
  assert.ok(
    buggy > 1000n * 10n ** 18n,
    `Test 1b failed: unflipped orientation should fabricate a huge number, got ${buggy}`,
  );
}

// ── Test 2: the real detector must find NO opportunity between identical pools
// FAILS on the buggy call sites, PASSES after the reserve-flip fix.
async function main(): Promise<void> {
  const swap: UniswapV2Swap = {
    txHash: '0x' + '11'.repeat(32),
    tokenIn: WETH,
    tokenOut: DAI,
    amountIn: 1n * 10n ** 18n,
    amountOutMin: 1n * 10n ** 18n, // makes the price-impact gate pass
    deadline: 0n,
    path: [WETH, DAI],
    router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    blockNumber: 0,
  };

  const lowGasPrice = 1n * 10n ** 9n; // 1 gwei, under the 50 gwei ceiling

  const result = await detectArbitrageOpportunity(
    swap,
    fakeProvider as unknown as JsonRpcProvider,
    lowGasPrice,
  );

  assert.strictEqual(
    result,
    null,
    'Test 2 failed: identical-price pools must yield NO opportunity, but got ' +
      (result === null ? 'null' : `netProfitWei=${(result as { netProfitWei: bigint }).netProfitWei}`),
  );

  console.log('✓ All reserve-flip invariant tests passed');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
