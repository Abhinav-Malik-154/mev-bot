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
  calculateArbitrageProfit,
  findOptimalAmountIn,
  formatEthAmount,
} from './math.js';
import {
  computePairAddress,
  getMultiplePoolReserves,
  sortTokens,
  UNISWAP_V2_FACTORY,
  UNISWAP_V2_INIT_CODE_HASH,
} from './pools.js';
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

/**
 * Estimates gas cost in wei given current gas price.
 */
function estimateGasCost(gasPriceWei: bigint): bigint {
  return ESTIMATED_GAS_UNITS * gasPriceWei;
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
