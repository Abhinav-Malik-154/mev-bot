/**
 * @file src/index.ts
 * @description MEV Searcher Bot — Main entry point.
 *
 * Initializes all subsystems in the correct order:
 * 1. Validate environment configuration
 * 2. Initialize SQLite database
 * 3. Start metrics auto-logging
 * 4. Start mempool monitor — watches for Uniswap V2 swaps (Phase 2)
 * 5. Run opportunity detector on each detected swap (Phase 3)
 * 6. Build transaction bundle and simulate on Anvil fork (Phase 4)
 *
 * Handles graceful shutdown on SIGINT/SIGTERM to ensure
 * the database is closed cleanly and final metrics are logged.
 */

import Database from 'better-sqlite3';
import { JsonRpcProvider, Wallet } from 'ethers';
import { config, validateConfig } from './config.js';
import { initDatabase, saveOpportunity } from './utils/db.js';
import { metrics } from './utils/metrics.js';
import { createModuleLogger } from './utils/logger.js';
import {
  createMempoolMonitor,
  isUniswapV2Swap,
  parseUniswapV2Swap,
  MempoolMonitor,
} from './mempool/index.js';
import {
  detectArbitrageOpportunity,
  getCurrentGasPrice,
  formatEthAmount,
} from './detector/index.js';
import { buildArbitrageBundle, simulateBundle } from './executor/index.js';
import type { PendingTransaction } from './types/index.js';

const logger = createModuleLogger('main');

const BANNER = `
███╗   ███╗███████╗██╗   ██╗    ██████╗  ██████╗ ████████╗
████╗ ████║██╔════╝██║   ██║    ██╔══██╗██╔═══██╗╚══██╔══╝
██╔████╔██║█████╗  ██║   ██║    ██████╔╝██║   ██║   ██║
██║╚██╔╝██║██╔══╝  ╚██╗ ██╔╝    ██╔══██╗██║   ██║   ██║
██║ ╚═╝ ██║███████╗ ╚████╔╝     ██████╔╝╚██████╔╝   ██║
╚═╝     ╚═╝╚══════╝  ╚═══╝      ╚═════╝  ╚═════╝    ╚═╝
         Flashbots MEV-Share | Uniswap V2/V3 Arbitrage
`;

function setupGracefulShutdown(database: Database.Database, monitor: MempoolMonitor): void {
  const shutdown = (): void => {
    logger.info('Shutdown signal received — draining...');
    void monitor.stop();
    logger.info(metrics.getSummary(), 'Final metrics');
    metrics.stopAutoLog();
    database.close();
    logger.info('Database closed cleanly. Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export async function main(): Promise<void> {
  process.stdout.write(BANNER + '\n');

  validateConfig();

  const db = initDatabase(config.dbPath);

  metrics.startAutoLog(60_000);

  const httpProvider = new JsonRpcProvider(config.httpUrl);
  const wallet = new Wallet(config.executorPrivateKey, httpProvider);

  logger.info({ chainId: config.chainId, relay: config.flashbotsRelayUrl }, 'Bot started');
  logger.info({ address: wallet.address }, 'Executor wallet loaded');

  const monitor = createMempoolMonitor();

  setupGracefulShutdown(db, monitor);

  await monitor.start(async (tx: PendingTransaction): Promise<void> => {
    if (!isUniswapV2Swap(tx)) return;
    const swap = parseUniswapV2Swap(tx);
    if (swap === null) return;

    logger.info(
      {
        txHash: swap.txHash,
        tokenIn: swap.tokenIn,
        tokenOut: swap.tokenOut,
        amountIn: swap.amountIn.toString(),
      },
      'Uniswap V2 swap detected',
    );

    const gasPrice = await getCurrentGasPrice(httpProvider);
    const opportunity = await detectArbitrageOpportunity(swap, httpProvider, gasPrice);
    if (opportunity === null) return;

    metrics.incrementOpportunityFound();
    logger.info(
      {
        id: opportunity.id,
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

    const currentBlock = await httpProvider.getBlockNumber();
    const targetBlock = currentBlock + 1;

    let bundle;
    try {
      bundle = await buildArbitrageBundle(opportunity, wallet, httpProvider, targetBlock);
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
      opportunity.tokenB,
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

    // Phase 5: Flashbots submission goes here
  });

  logger.info('Phase 4 active ✓ — building and simulating bundles');

  await new Promise<void>(() => undefined); // keeps process alive — removed in Phase 5
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console -- logger may not be initialised at fatal startup failure
  console.error('Fatal startup error:', err);
  process.exit(1);
});
