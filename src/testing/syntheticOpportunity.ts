/**
 * @file src/testing/syntheticOpportunity.ts
 * @description Builds a fabricated ArbitrageOpportunity for end-to-end
 * pipeline verification.
 *
 * ## What this is for, and what it is NOT for
 * The detection pipeline had never been observed running end to end — the
 * database held zero rows, so "does the whole chain actually connect?" was an
 * open question. This harness answers it by pushing one opportunity through
 * the real code path: record → SQLite → dashboard → bundle build → Anvil
 * simulation → the read-only relay gate.
 *
 * It is **not** a speed demonstration and must never be used as one. A
 * fabricated opportunity skips every network round-trip that dominates real
 * latency, so timings taken from it are meaningless. Latency numbers come
 * only from real mempool traffic.
 *
 * It also does not manufacture a *successful* trade. Simulation is expected
 * to reject it, because no real arbitrage exists at these reserves. That
 * rejection is a true result: it proves the simulator is doing its job rather
 * than rubber-stamping whatever it is handed.
 *
 * Every opportunity produced here carries `synthetic: true`, which is stored
 * in SQLite and rendered as a badge on the dashboard, so a test run can never
 * be mistaken for a real detection.
 */

import { randomUUID } from 'node:crypto';
import { computePairAddress, UNISWAP_V2_FACTORY, UNISWAP_V2_INIT_CODE_HASH } from '../detector/pools.js';
import type { ArbitrageOpportunity, UniswapV2Swap } from '../types/index.js';

/** Canonical mainnet addresses — real pools, so bundle building has real inputs. */
const MAINNET_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const MAINNET_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
/** Uniswap V2 router — the address a real victim swap would target. */
const MAINNET_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

/**
 * Fabricates a victim swap. The calldata is deliberately empty: this object is
 * handed directly to the detector output path, never re-parsed, and putting
 * fake-but-plausible calldata here would only invite someone to trust it.
 */
function syntheticSwap(blockNumber: number): UniswapV2Swap {
  return {
    txHash: `0xsynthetic${randomUUID().replace(/-/g, '')}`.slice(0, 66),
    tokenIn: MAINNET_WETH,
    tokenOut: MAINNET_USDC,
    amountIn: 10n ** 18n, // 1 WETH
    amountOutMin: 0n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    path: [MAINNET_WETH, MAINNET_USDC],
    router: MAINNET_V2_ROUTER,
    blockNumber,
  };
}

/**
 * Builds one synthetic opportunity whose net profit sits just above
 * `minProfitWei`, so it passes the same threshold a real opportunity must
 * clear and exercises the downstream path rather than being filtered out.
 */
export function buildSyntheticOpportunity(
  minProfitWei: bigint,
  blockNumber: number,
): ArbitrageOpportunity {
  const swapTx = syntheticSwap(blockNumber);

  // Comfortably above the threshold so it is never filtered for being marginal.
  const netProfitWei = minProfitWei * 2n;
  const estimatedGasCostWei = 300_000n * 20n * 10n ** 9n; // 300k gas @ 20 gwei
  const poolA = computePairAddress(
    MAINNET_WETH,
    MAINNET_USDC,
    UNISWAP_V2_FACTORY,
    UNISWAP_V2_INIT_CODE_HASH,
  );

  return {
    id: randomUUID(),
    strategyType: 'v2-v2',
    synthetic: true,
    timestamp: Date.now(),
    swapTx,
    tokenA: MAINNET_WETH,
    tokenB: MAINNET_USDC,
    poolA,
    // Second leg intentionally reuses the same pool: this harness proves the
    // pipeline connects, and a fabricated second pool address would fail the
    // bundle builder for the wrong reason.
    poolB: poolA,
    estimatedProfitWei: netProfitWei + estimatedGasCostWei,
    estimatedGasCostWei,
    netProfitWei,
    isProfitable: true,
    confidence: 1,
  };
}
