/**
 * @file src/detector/arbitrage.ts
 * @description Arbitrage opportunity detector.
 *
 * When a large pending swap is detected, this module:
 * 1. Fetches reserves from the target pool
 * 2. Finds alternative pools with the same token pair
 * 3. Calculates whether a price difference exists
 * 4. Estimates profit after gas costs
 * 5. Returns an ArbitrageOpportunity if profitable
 *
 * Minimum thresholds prevent wasting gas on tiny opportunities:
 * - Minimum price impact: 50 bps (0.5%) on the pending swap
 * - Minimum net profit: from config.minProfitWei
 * - Maximum gas price: from config.maxGasPriceGwei
 *
 * Confidence score (0.0 - 1.0) factors in:
 * - Price impact magnitude (higher = more confident)
 * - Pool liquidity depth (deeper = more confident)
 * - Gas price relative to profit (lower ratio = more confident)
 */

import { JsonRpcProvider } from 'ethers';
import { randomUUID } from 'node:crypto';
import { createModuleLogger } from '../utils/logger.js';
import { config } from '../config.js';
import { metrics } from '../utils/metrics.js';
import {
  calculatePriceImpactBps,
  findOptimalAmountIn,
  getAmountOut,
  formatEthAmount,
} from './math.js';
import {
  computePairAddress,
  getMultiplePoolReserves,
  getPoolReserves,
  sortTokens,
  UNISWAP_V2_FACTORY,
  UNISWAP_V2_INIT_CODE_HASH,
} from './pools.js';
import {
  getV3PoolState,
  estimateV3AmountOut,
  computeV3PoolAddress,
  UNISWAP_V3_FACTORY,
  type V3PoolState,
} from './uniswapV3.js';
import { getAmountOutWasm, isWasmMathLoaded } from './wasmMath.js';
import type { UniswapV2Swap, ArbitrageOpportunity, PoolReserves } from '../types/index.js';

const logger = createModuleLogger('arbitrage');

// Minimum price impact to bother checking (50 bps = 0.5%)
const MIN_PRICE_IMPACT_BPS = 50n;

// Alternative pool factories to check for price differences.
// We look for the same token pair on different DEXes.
const ALTERNATIVE_FACTORIES: ReadonlyArray<{
  name: string;
  factory: string;
  initCodeHash: string;
}> = [
  {
    name: 'SushiSwap',
    factory: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
    initCodeHash: '0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303',
  },
];

// Estimated gas for a two-hop arbitrage transaction
const ESTIMATED_GAS_UNITS = 250_000n;

// V3 swaps touch tick bitmaps and oracle slots, so a V2↔V3 round trip
// burns more gas than a pure V2↔V2 arb. Budget accordingly.
const ESTIMATED_V2V3_GAS_UNITS = 320_000n;

// Fee tiers we probe for a same-pair V3 pool. 0.05% and 0.3% carry the
// deepest liquidity on most pairs; cheaper to skip 0.01%/1% in the hot path.
const V3_PROBE_FEE_TIERS: readonly number[] = [500, 3000];

/**
 * Estimates gas cost in wei given current gas price.
 */
function estimateGasCost(gasPriceWei: bigint): bigint {
  return ESTIMATED_GAS_UNITS * gasPriceWei;
}

/**
 * Gas cost for a cross-protocol (V2↔V3) round trip.
 */
function estimateV2V3GasCost(gasPriceWei: bigint): bigint {
  return ESTIMATED_V2V3_GAS_UNITS * gasPriceWei;
}

/**
 * Cheap WASM pre-filter run before the expensive optimal-amount search.
 *
 * Design: WASM for speed on the high-frequency filter, TS bigint for precision
 * on the final number. A single round-trip quote (buy then sell a probe amount,
 * both directions) tells us whether a pair has *any* edge before we spend the
 * 64-iteration findOptimalAmountIn twice. The precise sizing/profit below always
 * uses the pure-TS getAmountOut.
 *
 * Fails open: returns true (do not skip) when WASM is unavailable or any value
 * exceeds the u64 range it accepts — the filter must never reject a real
 * opportunity, only cheaply discard hopeless ones.
 */
function wasmRoundTripHasEdge(
  probeIn: bigint,
  rInA: bigint,
  rOutA: bigint,
  rInB: bigint,
  rOutB: bigint,
): boolean {
  if (!isWasmMathLoaded() || probeIn <= 0n) return true;
  try {
    const fwd = getAmountOutWasm(getAmountOutWasm(probeIn, rInA, rOutA), rInB, rOutB);
    const rev = getAmountOutWasm(getAmountOutWasm(probeIn, rInB, rOutB), rInA, rOutA);
    return fwd > probeIn || rev > probeIn;
  } catch {
    return true; // out of u64 range — defer to the precise pure-TS path
  }
}

/**
 * Binary-searches the input amount that maximises an arbitrary profit
 * function over [1, maxAmountIn]. Mirrors findOptimalAmountIn's 64-iteration
 * derivative search but accepts any `profitFn`, so it works for the mixed
 * V2/V3 legs where the closed-form four-reserve helper does not apply.
 */
function searchOptimalAmountIn(
  maxAmountIn: bigint,
  profitFn: (amountIn: bigint) => bigint,
): { optimalAmountIn: bigint; expectedProfit: bigint } {
  if (maxAmountIn <= 0n) return { optimalAmountIn: 0n, expectedProfit: 0n };

  let lo = 1n;
  let hi = maxAmountIn;
  let bestAmount = 0n;
  let bestProfit = 0n;

  for (let i = 0; i < 64; i++) {
    if (lo >= hi) break;
    const mid = (lo + hi) / 2n;
    const profitMid = profitFn(mid);
    const profitMidPlus1 = profitFn(mid + 1n);

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
 * Calculates confidence score for an opportunity (0.0 to 1.0).
 * Higher confidence = more likely to be profitable when executed.
 */
function calculateConfidence(
  priceImpactBps: bigint,
  netProfitWei: bigint,
  gasCostWei: bigint,
  reserveDepth: bigint,
): number {
  // Impact component: 50 bps = 0.1, 500 bps = 0.5, capped at 1.0
  const impactScore = Math.min(Number(priceImpactBps) / 1000, 1.0);

  // Liquidity component: deeper pool = more confident the arb fills cleanly
  // Normalize against 1000 ETH (10^21 wei) as a reference deep pool
  const referenceDepth = 10n ** 21n;
  const liquidityScore = Math.min(Number((reserveDepth * 100n) / referenceDepth) / 100, 1.0);

  // Profit-to-gas ratio: profit should be at least 3x gas cost for high confidence
  const profitRatio = gasCostWei > 0n ? Number((netProfitWei * 100n) / gasCostWei) / 300 : 1.0;
  const profitScore = Math.min(profitRatio, 1.0);

  return Math.round(((impactScore + liquidityScore + profitScore) / 3) * 100) / 100;
}

/**
 * Main function: analyzes a pending Uniswap V2 swap for arbitrage.
 * Returns ArbitrageOpportunity if profitable, null otherwise.
 *
 * Flow:
 * 1. Check price impact meets minimum threshold
 * 2. Fetch reserves from primary pool
 * 3. Check alternative pools for price difference
 * 4. Calculate optimal entry amount and expected profit
 * 5. Subtract gas cost to get net profit
 * 6. Return opportunity if net profit > config.minProfitWei
 */
export async function detectArbitrageOpportunity(
  swap: UniswapV2Swap,
  provider: JsonRpcProvider,
  currentGasPriceWei: bigint,
): Promise<ArbitrageOpportunity | null> {
  const maxGasPriceWei = config.maxGasPriceGwei * 10n ** 9n;
  if (currentGasPriceWei > maxGasPriceWei) {
    logger.debug(
      { gasPriceGwei: currentGasPriceWei / 10n ** 9n },
      'Gas price exceeds max — skipping',
    );
    return null;
  }

  const priceImpactBps = calculatePriceImpactBps(swap.amountIn, swap.amountIn + swap.amountOutMin);
  if (priceImpactBps < MIN_PRICE_IMPACT_BPS) {
    logger.debug({ priceImpactBps: priceImpactBps.toString() }, 'Price impact too low — skipping');
    return null;
  }

  const tokenA = swap.tokenIn;
  const tokenB = swap.tokenOut;

  const primaryPoolAddress = computePairAddress(
    tokenA,
    tokenB,
    UNISWAP_V2_FACTORY,
    UNISWAP_V2_INIT_CODE_HASH,
  );

  const altPoolAddresses = ALTERNATIVE_FACTORIES.map((f) =>
    computePairAddress(tokenA, tokenB, f.factory, f.initCodeHash),
  );

  const allAddresses = [primaryPoolAddress, ...altPoolAddresses];
  const reservesMap = await getMultiplePoolReserves(allAddresses, provider);

  const primaryReserves = reservesMap.get(primaryPoolAddress);
  if (primaryReserves === undefined) {
    logger.debug({ primaryPoolAddress }, 'Primary pool has no reserves — skipping');
    return null;
  }

  const [token0] = sortTokens(tokenA, tokenB);
  const primaryIsToken0 = tokenA.toLowerCase() === token0.toLowerCase();
  const primaryReserveIn = primaryIsToken0 ? primaryReserves.reserve0 : primaryReserves.reserve1;
  const primaryReserveOut = primaryIsToken0 ? primaryReserves.reserve1 : primaryReserves.reserve0;

  let bestOpportunity: ArbitrageOpportunity | null = null;

  for (let i = 0; i < altPoolAddresses.length; i++) {
    const altAddress = altPoolAddresses[i];
    if (altAddress === undefined) continue;
    const altReserves = reservesMap.get(altAddress);
    if (altReserves === undefined) continue;

    const altFactory = ALTERNATIVE_FACTORIES[i];
    if (altFactory === undefined) continue;

    const altReserveIn = primaryIsToken0 ? altReserves.reserve0 : altReserves.reserve1;
    const altReserveOut = primaryIsToken0 ? altReserves.reserve1 : altReserves.reserve0;

    // Cap search at 10% of the smaller reserve to avoid depleting a pool
    const maxAmountIn =
      (primaryReserveIn < altReserveIn ? primaryReserveIn : altReserveIn) / 10n;
    if (maxAmountIn === 0n) continue;

    // Fast WASM gate: skip the pair if a nominal round trip shows no edge.
    if (!wasmRoundTripHasEdge(maxAmountIn / 2n, primaryReserveIn, primaryReserveOut, altReserveIn, altReserveOut)) {
      logger.debug({ dex: altFactory.name }, 'WASM pre-filter: no round-trip edge — skipping');
      continue;
    }

    // Try primary→alt direction
    const { optimalAmountIn: amtA, expectedProfit: profitA } = findOptimalAmountIn(
      primaryReserveIn,
      primaryReserveOut,
      altReserveIn,
      altReserveOut,
      maxAmountIn,
    );

    // Try alt→primary direction
    const { optimalAmountIn: amtB, expectedProfit: profitB } = findOptimalAmountIn(
      altReserveIn,
      altReserveOut,
      primaryReserveIn,
      primaryReserveOut,
      maxAmountIn,
    );

    const useAtoB = profitA >= profitB;
    const grossProfit = useAtoB ? profitA : profitB;
    const optimalAmountIn = useAtoB ? amtA : amtB;

    if (grossProfit === 0n || optimalAmountIn === 0n) continue;

    const gasCostWei = estimateGasCost(currentGasPriceWei);
    const netProfitWei = grossProfit - gasCostWei;

    if (netProfitWei < config.minProfitWei) {
      logger.debug(
        {
          netProfitEth: formatEthAmount(netProfitWei < 0n ? 0n : netProfitWei, 6),
          dex: altFactory.name,
        },
        'Net profit below threshold — skipping',
      );
      continue;
    }

    const reserveDepth = primaryReserveIn + altReserveIn;
    const confidence = calculateConfidence(
      priceImpactBps,
      netProfitWei,
      gasCostWei,
      reserveDepth,
    );

    const poolA = useAtoB ? primaryPoolAddress : altAddress;
    const poolB = useAtoB ? altAddress : primaryPoolAddress;

    const opportunity: ArbitrageOpportunity = {
      id: randomUUID(),
      strategyType: 'v2-v2',
      timestamp: Date.now(),
      swapTx: swap,
      tokenA,
      tokenB,
      poolA,
      poolB,
      estimatedProfitWei: grossProfit,
      estimatedGasCostWei: gasCostWei,
      netProfitWei,
      isProfitable: true,
      confidence,
    };

    logger.debug(
      {
        dex: altFactory.name,
        netProfitEth: formatEthAmount(netProfitWei, 6),
        confidence,
      },
      'Candidate opportunity',
    );

    if (bestOpportunity === null || netProfitWei > bestOpportunity.netProfitWei) {
      bestOpportunity = opportunity;
    }
  }

  if (bestOpportunity !== null) {
    metrics.incrementOpportunityFound();
  }

  return bestOpportunity;
}

/**
 * Computes the best cross-protocol profit for a single V3 pool against the
 * already-oriented V2 reserves, trying both trade directions and searching
 * for the optimal input size. Returns the winning direction and its profit.
 *
 * tokenA is the input/output asset of the loop (we start and end in tokenA);
 * tokenB is the intermediate asset.
 */
function bestV2V3DirectionProfit(
  tokenA: string,
  v2ReserveInA: bigint,
  v2ReserveOutB: bigint,
  v3: V3PoolState,
  maxAmountIn: bigint,
): { grossProfit: bigint; optimalAmountIn: bigint; v2First: boolean } {
  // Orientation for the V3 leg: a swap whose input token equals V3 token0 is
  // "zeroForOne". We resolve this per-leg from the V3 pool's sorted tokens.
  const tokenAIsV3Token0 = tokenA.toLowerCase() === v3.token0.toLowerCase();

  // Direction 1: buy tokenB cheap on V2, sell it back on V3.
  //   tokenA --V2--> tokenB --V3--> tokenA
  const profitV2First = (amountIn: bigint): bigint => {
    const mid = getAmountOut(amountIn, v2ReserveInA, v2ReserveOutB);
    if (mid === 0n) return 0n;
    // tokenB -> tokenA on V3: zeroForOne when tokenB is V3 token0,
    // i.e. when tokenA is NOT token0.
    const out = estimateV3AmountOut(mid, v3.sqrtPriceX96, v3.liquidity, !tokenAIsV3Token0, v3.fee);
    return out > amountIn ? out - amountIn : 0n;
  };

  // Direction 2: buy tokenB on V3, sell it back on V2.
  //   tokenA --V3--> tokenB --V2--> tokenA
  const profitV3First = (amountIn: bigint): bigint => {
    // tokenA -> tokenB on V3: zeroForOne when tokenA is V3 token0.
    const mid = estimateV3AmountOut(amountIn, v3.sqrtPriceX96, v3.liquidity, tokenAIsV3Token0, v3.fee);
    if (mid === 0n) return 0n;
    // tokenB -> tokenA on V2 uses the reversed reserves.
    const out = getAmountOut(mid, v2ReserveOutB, v2ReserveInA);
    return out > amountIn ? out - amountIn : 0n;
  };

  const d1 = searchOptimalAmountIn(maxAmountIn, profitV2First);
  const d2 = searchOptimalAmountIn(maxAmountIn, profitV3First);

  if (d1.expectedProfit >= d2.expectedProfit) {
    return { grossProfit: d1.expectedProfit, optimalAmountIn: d1.optimalAmountIn, v2First: true };
  }
  return { grossProfit: d2.expectedProfit, optimalAmountIn: d2.optimalAmountIn, v2First: false };
}

/**
 * Checks for arbitrage between a V2 pool and a V3 pool for the same pair.
 * Often more profitable than V2-vs-V2 due to concentrated liquidity dynamics:
 * V3's price reacts differently to large swaps, so V2 and V3 quotes for the
 * same pair drift apart more than two V2 pools ever would.
 *
 * Flow:
 * 1. Gas-price ceiling and price-impact threshold (same as V2↔V2).
 * 2. Fetch V2 reserves for the pair (reusing getPoolReserves).
 * 3. For each standard V3 fee tier, derive the pool address and read state.
 * 4. For every live V3 pool, search both directions for the optimal trade.
 * 5. Apply the same gas/profit thresholds and return the best opportunity.
 */
export async function detectV2V3CrossArbitrage(
  swap: UniswapV2Swap,
  provider: JsonRpcProvider,
  currentGasPriceWei: bigint,
): Promise<ArbitrageOpportunity | null> {
  const maxGasPriceWei = config.maxGasPriceGwei * 10n ** 9n;
  if (currentGasPriceWei > maxGasPriceWei) {
    logger.debug(
      { gasPriceGwei: currentGasPriceWei / 10n ** 9n },
      'Gas price exceeds max — skipping V2/V3',
    );
    return null;
  }

  const priceImpactBps = calculatePriceImpactBps(swap.amountIn, swap.amountIn + swap.amountOutMin);
  if (priceImpactBps < MIN_PRICE_IMPACT_BPS) {
    logger.debug(
      { priceImpactBps: priceImpactBps.toString() },
      'Price impact too low — skipping V2/V3',
    );
    return null;
  }

  const tokenA = swap.tokenIn;
  const tokenB = swap.tokenOut;

  // ── V2 leg ──────────────────────────────────────────────────────────────
  const v2PoolAddress = computePairAddress(
    tokenA,
    tokenB,
    UNISWAP_V2_FACTORY,
    UNISWAP_V2_INIT_CODE_HASH,
  );
  const v2Reserves = await getPoolReserves(v2PoolAddress, provider);
  if (v2Reserves === null) {
    logger.debug({ v2PoolAddress }, 'V2 pool has no reserves — skipping V2/V3');
    return null;
  }

  const [token0] = sortTokens(tokenA, tokenB);
  const tokenAIsToken0 = tokenA.toLowerCase() === token0.toLowerCase();
  const v2ReserveInA = tokenAIsToken0 ? v2Reserves.reserve0 : v2Reserves.reserve1;
  const v2ReserveOutB = tokenAIsToken0 ? v2Reserves.reserve1 : v2Reserves.reserve0;

  // ── V3 legs ─────────────────────────────────────────────────────────────
  const v3PoolAddresses = await Promise.all(
    V3_PROBE_FEE_TIERS.map((fee) =>
      computeV3PoolAddress(tokenA, tokenB, fee, UNISWAP_V3_FACTORY),
    ),
  );
  const v3States = await Promise.all(
    v3PoolAddresses.map((addr) => getV3PoolState(addr, provider)),
  );

  let bestOpportunity: ArbitrageOpportunity | null = null;

  for (let i = 0; i < v3States.length; i++) {
    const v3 = v3States[i];
    const v3PoolAddress = v3PoolAddresses[i];
    const feeTier = V3_PROBE_FEE_TIERS[i];
    if (v3 === undefined || v3 === null || v3PoolAddress === undefined || feeTier === undefined) {
      continue;
    }
    if (v3.liquidity === 0n) continue;

    // Cap the search at 10% of the V2 tokenA reserve to avoid depleting it.
    const maxAmountIn = v2ReserveInA / 10n;
    if (maxAmountIn === 0n) continue;

    const { grossProfit, optimalAmountIn, v2First } = bestV2V3DirectionProfit(
      tokenA,
      v2ReserveInA,
      v2ReserveOutB,
      v3,
      maxAmountIn,
    );

    if (grossProfit === 0n || optimalAmountIn === 0n) continue;

    const gasCostWei = estimateV2V3GasCost(currentGasPriceWei);
    const netProfitWei = grossProfit - gasCostWei;

    if (netProfitWei < config.minProfitWei) {
      logger.debug(
        { netProfitEth: formatEthAmount(netProfitWei < 0n ? 0n : netProfitWei, 6), feeTier },
        'V2/V3 net profit below threshold — skipping',
      );
      continue;
    }

    const reserveDepth = v2ReserveInA + v3.liquidity;
    const confidence = calculateConfidence(priceImpactBps, netProfitWei, gasCostWei, reserveDepth);

    // poolA is the first leg, poolB the second, matching execution order.
    const poolA = v2First ? v2PoolAddress : v3PoolAddress;
    const poolB = v2First ? v3PoolAddress : v2PoolAddress;

    const opportunity: ArbitrageOpportunity = {
      id: randomUUID(),
      strategyType: 'v2-v3',
      timestamp: Date.now(),
      swapTx: swap,
      tokenA,
      tokenB,
      poolA,
      poolB,
      estimatedProfitWei: grossProfit,
      estimatedGasCostWei: gasCostWei,
      netProfitWei,
      isProfitable: true,
      confidence,
    };

    logger.debug(
      { feeTier, v2First, netProfitEth: formatEthAmount(netProfitWei, 6), confidence },
      'Candidate V2/V3 opportunity',
    );

    if (bestOpportunity === null || netProfitWei > bestOpportunity.netProfitWei) {
      bestOpportunity = opportunity;
    }
  }

  if (bestOpportunity !== null) {
    metrics.incrementOpportunityFound();
  }

  return bestOpportunity;
}

/**
 * Fetches current gas price from provider.
 * Returns maxGasPriceGwei from config if fetch fails.
 */
export async function getCurrentGasPrice(provider: JsonRpcProvider): Promise<bigint> {
  try {
    const feeData = await provider.getFeeData();
    if (feeData.gasPrice !== null) return feeData.gasPrice;
    if (feeData.maxFeePerGas !== null) return feeData.maxFeePerGas;
    return config.maxGasPriceGwei * 10n ** 9n;
  } catch (err: unknown) {
    logger.warn({ err }, 'Failed to fetch gas price — using config max');
    return config.maxGasPriceGwei * 10n ** 9n;
  }
}

// Re-export for pool reserve type usage in callers
export type { PoolReserves };
