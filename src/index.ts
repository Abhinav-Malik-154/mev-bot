/**
 * @file src/index.ts
 * @description MEV Searcher Bot — Main entry point.
 *
 * Initializes all subsystems in the correct order:
 * 1. Validate environment configuration
 * 2. Initialize SQLite database
 * 3. Start metrics auto-logging
 * 4. Create HTTP provider + executor wallet
 * 5. Create Flashbots relay client (Phase 5)
 * 6. Start live dashboard server on port 3000 (Phase 7)
 * 7. Start mempool monitor — watches for Uniswap V2 swaps (Phase 2)
 * 8. Run opportunity detector on each detected swap (Phase 3)
 * 9. Build transaction bundle and simulate on Anvil fork (Phase 4)
 * 10. Submit confirmed bundles to Flashbots MEV-Share relay (Phase 5)
 *
 * Handles graceful shutdown on SIGINT/SIGTERM to ensure
 * the database is closed cleanly and final metrics are logged.
 */

import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { JsonRpcProvider, Wallet, parseEther } from 'ethers';
import { config, validateConfig } from './config.js';
import { initDatabase, saveOpportunity, saveBundle } from './utils/db.js';
import { metrics } from './utils/metrics.js';
import { rateLimitBackoff } from './utils/rateLimiter.js';
import { latencyTracker } from './utils/latencyTracker.js';
import { createModuleLogger } from './utils/logger.js';
import {
  createMempoolMonitor,
  isUniswapV2Swap,
  parseUniswapV2Swap,
  MempoolMonitor,
} from './mempool/index.js';
import {
  detectArbitrageOpportunity,
  detectV2V3CrossArbitrage,
  getCurrentGasPrice,
  formatEthAmount,
  loadWasmMath,
} from './detector/index.js';
import { findBestTriangularArbitrage, HUB_TOKENS } from './detector/multiHop.js';
import type { TriangularOpportunity } from './detector/multiHop.js';
import type { ArbitrageOpportunity, UniswapV2Swap, PendingTransaction } from './types/index.js';
import { buildArbitrageBundle, simulateBundle } from './executor/index.js';
import {
  createFlashbotsProvider,
  submitBundle,
  bundleTracker,
} from './flashbots/index.js';
import { createDashboardServer, dashboardState, DashboardServer } from './dashboard/index.js';
import { buildSyntheticOpportunity } from './testing/syntheticOpportunity.js';

const logger = createModuleLogger('main');

// Canonical WETH hub — the start/end token for the triangular-arbitrage search.
const WETH_ADDRESS = HUB_TOKENS.find((t) => t.symbol === 'WETH')?.address ?? '';

// Fixed probe size for triangular path evaluation (independent of the victim swap).
const TRIANGULAR_TEST_AMOUNT = parseEther('0.1');

// A triangular loop runs three swaps (plus approvals), so it burns more gas than
// a two-leg V2 arb. Used to net the gross estimate for a like-for-like compare.
const TRIANGULAR_GAS_UNITS = 400_000n;

const BANNER = `
███╗   ███╗███████╗██╗   ██╗    ██████╗  ██████╗ ████████╗
████╗ ████║██╔════╝██║   ██║    ██╔══██╗██╔═══██╗╚══██╔══╝
██╔████╔██║█████╗  ██║   ██║    ██████╔╝██║   ██║   ██║
██║╚██╔╝██║██╔══╝  ╚██╗ ██╔╝    ██╔══██╗██║   ██║   ██║
██║ ╚═╝ ██║███████╗ ╚████╔╝     ██████╔╝╚██████╔╝   ██║
╚═╝     ╚═╝╚══════╝  ╚═══╝      ╚═════╝  ╚═════╝    ╚═╝
         Flashbots MEV-Share | Uniswap V2/V3 Arbitrage
`;

/**
 * Returns the more profitable of two candidate opportunities by net profit.
 * Either argument may be null; returns null only when both are null.
 */
function pickBestOpportunity(
  a: ArbitrageOpportunity | null,
  b: ArbitrageOpportunity | null,
): ArbitrageOpportunity | null {
  if (a === null) return b;
  if (b === null) return a;
  return b.netProfitWei > a.netProfitWei ? b : a;
}

/**
 * Adapts a triangular result into the shared ArbitrageOpportunity shape so it
 * competes and logs alongside the two-leg strategies. tokenA/poolA are the
 * loop's start token and first pool; the first intermediate hop is tokenB.
 * Returns null when the loop's net profit (gross minus 3-leg gas) is below the
 * configured threshold, matching how the two-leg detectors self-filter.
 */
function triangularToOpportunity(
  tri: TriangularOpportunity,
  swap: UniswapV2Swap,
  gasPriceWei: bigint,
): ArbitrageOpportunity | null {
  const gasCostWei = TRIANGULAR_GAS_UNITS * gasPriceWei;
  const netProfitWei = tri.profitWei - gasCostWei;
  if (netProfitWei < config.minProfitWei) return null;

  const ratio = gasCostWei > 0n ? Number((netProfitWei * 100n) / gasCostWei) / 300 : 0;
  return {
    id: randomUUID(),
    strategyType: 'triangular',
    synthetic: false,
    timestamp: Date.now(),
    swapTx: swap,
    tokenA: tri.path.tokens[0],
    tokenB: tri.path.tokens[1],
    poolA: tri.path.pools[0],
    poolB: tri.path.pools[1],
    estimatedProfitWei: tri.profitWei,
    estimatedGasCostWei: gasCostWei,
    netProfitWei,
    isProfitable: true,
    confidence: Math.max(0, Math.min(ratio, 1)),
  };
}

/**
 * Records a detected opportunity everywhere it needs to surface: metrics,
 * structured log, SQLite, and the live dashboard. The dashboard broadcast is
 * left to the caller so recording several opportunities in one pass produces
 * a single push rather than one per record.
 */
function recordOpportunity(db: Database.Database, opportunity: ArbitrageOpportunity): void {
  // The opportunities counter means "real arbitrage detected on-chain", so a
  // fabricated one must not inflate it. The row is still written and shown,
  // carrying its SYNTHETIC badge — visible, but never counted as a detection.
  if (!opportunity.synthetic) {
    metrics.incrementOpportunityFound();
  }
  logger.info(
    {
      id: opportunity.id,
      strategyType: opportunity.strategyType,
      tokenA: opportunity.tokenA,
      tokenB: opportunity.tokenB,
      estimatedProfitWei: opportunity.estimatedProfitWei.toString(),
      netProfitWei: opportunity.netProfitWei.toString(),
      estimatedGasCostWei: opportunity.estimatedGasCostWei.toString(),
      confidence: opportunity.confidence,
      swapTx: {
        txHash: opportunity.swapTx.txHash,
        amountIn: opportunity.swapTx.amountIn.toString(),
      },
    },
    'Arbitrage opportunity detected!',
  );
  saveOpportunity(db, opportunity);
  dashboardState.addOpportunity(opportunity);
}

function setupGracefulShutdown(
  database: Database.Database,
  monitor: MempoolMonitor,
  dashboardServer: DashboardServer,
): void {
  const shutdown = (): void => {
    logger.info('Shutdown signal received — draining...');
    void monitor.stop();
    void dashboardServer.stop();
    dashboardState.setBotStatus('stopped');
    logger.info(metrics.getSummary(), 'Final metrics');
    metrics.stopAutoLog();
    database.close();
    logger.info('Database closed cleanly. Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Everything that happens after an opportunity has been chosen: build the
 * bundle, simulate it on an Anvil fork, and submit through the relay (which
 * hard-gates on read-only mode).
 *
 * Extracted from the mempool callback so the synthetic test harness drives the
 * exact same code path a real detection does. A harness that ran a parallel
 * copy of this logic would prove nothing about the real one.
 */
async function executeOpportunity(
  executable: ArbitrageOpportunity,
  deps: {
    db: Database.Database;
    wallet: Wallet;
    httpProvider: JsonRpcProvider;
    flashbotsProvider: Awaited<ReturnType<typeof createFlashbotsProvider>>;
    dashboardServer: DashboardServer;
  },
): Promise<void> {
  const { db, wallet, httpProvider, flashbotsProvider, dashboardServer } = deps;

  // ── Phase 4: build bundle + Anvil simulation ─────────────────────────
  let currentBlock: number;
  try {
    await rateLimitBackoff.waitIfNeeded();
    currentBlock = await httpProvider.getBlockNumber();
  } catch (err: unknown) {
    if (rateLimitBackoff.isRateLimitError(err)) {
      rateLimitBackoff.recordRateLimit();
      metrics.incrementRateLimitError();
      logger.warn({ method: 'eth_blockNumber' }, 'RPC rate limited (429) — skipping opportunity');
    } else {
      logger.warn({ err }, 'Failed to fetch current block — skipping opportunity');
    }
    return;
  }
  const targetBlock = currentBlock + 1;

  let bundle;
  try {
    bundle = await buildArbitrageBundle(executable, wallet, httpProvider, targetBlock);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ reason }, 'Bundle build failed — skipping opportunity');
    return;
  }

  logger.info(
    { targetBlock, txCount: bundle.transactions.length },
    'Bundle built',
  );

  const simulation = await simulateBundle(
    bundle,
    config.httpUrl,
    wallet.address,
    executable.tokenB,
  );

  if (!simulation.success) {
    logger.warn(
      { revertReason: simulation.revertReason },
      'Simulation failed — skipping',
    );
    return;
  }

  if (simulation.profitWei < config.minProfitWei) {
    logger.info(
      { profitEth: formatEthAmount(simulation.profitWei, 6) },
      'Simulated profit below threshold — skipping',
    );
    return;
  }

  logger.info(
    {
      profitEth: formatEthAmount(simulation.profitWei, 6),
      gasUsed: simulation.gasUsed.toString(),
    },
    'Simulation successful ✓',
  );

  // ── Phase 5: Flashbots MEV-Share submission ──────────────────────────
  const bundleId = randomUUID();
  bundleTracker.trackSubmission(bundleId, bundle.targetBlockNumber);

  const result = await submitBundle(bundle, flashbotsProvider, wallet, httpProvider);

  bundleTracker.recordResult(bundleId, result);
  saveBundle(db, { ...result, id: bundleId });

  // Push bundle result to dashboard immediately
  dashboardState.addBundle({ ...result, id: bundleId });
  dashboardServer.broadcastUpdate();

  if (result.success) {
    metrics.addProfit(result.profitWei);
    logger.info(
      {
        profitEth: formatEthAmount(result.profitWei, 6),
        bundleHash: result.bundleHash,
        blockNumber: result.blockNumber,
      },
      'Bundle included — profit captured!',
    );
  } else {
    logger.warn({ error: result.error }, 'Bundle not included');
  }

  const stats = bundleTracker.getStats();
  logger.info(
    { successRate: stats.successRate, totalProfitEth: stats.totalProfitEth },
    'Bundle stats updated',
  );

  // Alert if we are consistently losing to competitors
  bundleTracker.isConsistentlyOutbid();
}

export async function main(): Promise<void> {
  process.stdout.write(BANNER + '\n');

  validateConfig();

  // Fault injection is a test tool, wired from config here so rateLimiter
  // itself stays free of config imports. 0 (the default) is a no-op.
  rateLimitBackoff.setFaultRate(config.injectFaultRate);

  // Load the Rust WASM AMM math module; the detector uses it as a fast pre-filter
  // when present and transparently falls back to pure-TS math otherwise.
  const wasmAvailable = await loadWasmMath();
  logger.info({ wasmAvailable }, wasmAvailable ? 'WASM math loaded' : 'WASM math unavailable — using TS fallback');

  const db = initDatabase(config.dbPath);

  metrics.startAutoLog(60_000);

  const httpProvider = new JsonRpcProvider(config.httpUrl);
  const wallet = new Wallet(config.executorPrivateKey, httpProvider);

  logger.info({ chainId: config.chainId, relay: config.flashbotsRelayUrl }, 'Bot started');
  logger.info({ address: wallet.address }, 'Executor wallet loaded');

  // Initialise the Flashbots relay client with a fresh reputation signer
  const flashbotsProvider = await createFlashbotsProvider(httpProvider);

  logger.info(
    { walletAddress: wallet.address, relay: config.flashbotsRelayUrl },
    'Full MEV pipeline ready',
  );

  // ── Phase 7: start live dashboard ────────────────────────────────────────
  const dashboardServer = createDashboardServer();
  await dashboardServer.start();
  dashboardState.setBotStatus('running');
  dashboardState.setWalletInfo(wallet.address, config.chainId);
  dashboardState.setReadOnlyMode(config.readOnlyMode);

  const monitor = createMempoolMonitor();

  setupGracefulShutdown(db, monitor, dashboardServer);

  // Push metrics to dashboard every 5 s (separate from the 60 s log interval)
  const metricsInterval = setInterval((): void => {
    dashboardState.updateMetrics(metrics.getSummary());
    dashboardServer.broadcastUpdate();
  }, 5_000);

  // Prevent the interval itself from blocking the process exit path
  metricsInterval.unref();

  await monitor.start(async (tx: PendingTransaction): Promise<void> => {
    const timer = latencyTracker.startTimer(tx.hash);
    if (!isUniswapV2Swap(tx)) return;
    const swap = parseUniswapV2Swap(tx);
    if (swap === null) return;
    timer.checkpoint('parse');

    logger.info(
      {
        txHash: swap.txHash,
        tokenIn: swap.tokenIn,
        tokenOut: swap.tokenOut,
        amountIn: swap.amountIn.toString(),
      },
      'Uniswap V2 swap detected',
    );

    // ── Phase 3: detect arbitrage opportunity ────────────────────────────
    // Run all three strategies in parallel and take the highest net profit:
    //   v2-v2       cross-DEX two-pool arb on the swapped pair
    //   v2-v3       cross-protocol arb (concentrated liquidity diverges further)
    //   triangular  WETH→hub→hub→WETH loop, independent of the swapped pair
    const gasPrice = await getCurrentGasPrice(httpProvider);
    const [v2Opportunity, v2v3Opportunity, triResult] = await Promise.all([
      detectArbitrageOpportunity(swap, httpProvider, gasPrice),
      detectV2V3CrossArbitrage(swap, httpProvider, gasPrice),
      findBestTriangularArbitrage(WETH_ADDRESS, TRIANGULAR_TEST_AMOUNT, httpProvider),
    ]);

    const triOpportunity =
      triResult !== null ? triangularToOpportunity(triResult, swap, gasPrice) : null;

    // Detection maths complete — record the calculation stage and finish the
    // sample (finish() logs the full per-tx breakdown at debug level only, to
    // avoid flooding logs). Push the rolling summary to the dashboard on every
    // examined swap — profitable or not — so the speed panel stays live.
    timer.checkpoint('calculation');
    timer.finish();
    dashboardState.updateLatency(latencyTracker.getSummary());

    const bestOverall: ArbitrageOpportunity | null = pickBestOpportunity(
      pickBestOpportunity(v2Opportunity, v2v3Opportunity),
      triOpportunity,
    );
    if (bestOverall === null) return;

    recordOpportunity(db, bestOverall);

    // The bundle builder assembles two-leg (poolA→poolB) bundles only, so a
    // triangular winner cannot be executed yet. Bailing out here would also
    // discard a profitable *two-leg* opportunity found on this same swap,
    // which is pure lost profit — triangular simply happened to score higher.
    // So: record the triangular winner, then execute the best two-leg
    // candidate if one exists.
    let executable = bestOverall;
    if (bestOverall.strategyType === 'triangular') {
      const bestTwoLeg = pickBestOpportunity(v2Opportunity, v2v3Opportunity);
      logger.info(
        {
          id: bestOverall.id,
          startToken: bestOverall.tokenA,
          firstHop: bestOverall.tokenB,
          fallbackStrategy: bestTwoLeg?.strategyType ?? null,
        },
        bestTwoLeg === null
          ? 'Triangular opportunity is best — 3-leg execution not yet wired; recorded only'
          : 'Triangular opportunity is best — 3-leg execution not yet wired; falling back to best two-leg',
      );
      if (bestTwoLeg === null) {
        dashboardServer.broadcastUpdate();
        return;
      }
      recordOpportunity(db, bestTwoLeg);
      executable = bestTwoLeg;
    }

    dashboardServer.broadcastUpdate();

    await executeOpportunity(executable, {
      db,
      wallet,
      httpProvider,
      flashbotsProvider,
      dashboardServer,
    });
  });

  // ── Test harness: synthetic opportunity ──────────────────────────────────
  // Pushes one fabricated, clearly-labelled opportunity through the identical
  // execution path a real detection uses, so every stage can be observed
  // connecting. Simulation is expected to reject it — no real arbitrage exists
  // at these reserves — and that rejection is itself a true result.
  if (config.injectOpportunity) {
    const blockNumber = await httpProvider.getBlockNumber();
    const synthetic = buildSyntheticOpportunity(config.minProfitWei, blockNumber);
    logger.warn(
      { id: synthetic.id, netProfitWei: synthetic.netProfitWei.toString() },
      '🧪 Injecting SYNTHETIC opportunity — flagged synthetic in SQLite and on the dashboard',
    );

    recordOpportunity(db, synthetic);
    dashboardServer.broadcastUpdate();

    try {
      await executeOpportunity(synthetic, {
        db,
        wallet,
        httpProvider,
        flashbotsProvider,
        dashboardServer,
      });
    } catch (err: unknown) {
      // A synthetic opportunity failing downstream is an expected outcome, not
      // a crash: log which stage stopped it and carry on monitoring.
      logger.warn({ err }, '🧪 Synthetic opportunity stopped in the pipeline — see stage logs above');
    }

    logger.info('🧪 Synthetic injection complete — pipeline traversal observed');
  }

  logger.info('Phase 7 active ✓ — dashboard running at http://localhost:3000');

  await new Promise<void>(() => undefined); // keeps process alive
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console -- logger may not be initialised at fatal startup failure
  console.error('Fatal startup error:', err);
  process.exit(1);
});
