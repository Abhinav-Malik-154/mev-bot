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
 *
 * Handles graceful shutdown on SIGINT/SIGTERM to ensure
 * the database is closed cleanly and final metrics are logged.
 */

import Database from 'better-sqlite3';
import { JsonRpcProvider } from 'ethers';
import { config, validateConfig } from './config.js';
import { initDatabase } from './utils/db.js';
import { metrics } from './utils/metrics.js';
import { createModuleLogger } from './utils/logger.js';
import { createMempoolMonitor, isUniswapV2Swap, parseUniswapV2Swap, MempoolMonitor } from './mempool/index.js';
import { detectArbitrageOpportunity, getCurrentGasPrice } from './detector/index.js';
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

  logger.info({ chainId: config.chainId, relay: config.flashbotsRelayUrl }, 'Bot started');

  const monitor = createMempoolMonitor();
  const httpProvider = new JsonRpcProvider(config.httpUrl);

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
    logger.info(
      {
        ...opportunity,
        estimatedProfitWei: opportunity.estimatedProfitWei.toString(),
        netProfitWei: opportunity.netProfitWei.toString(),
        estimatedGasCostWei: opportunity.estimatedGasCostWei.toString(),
        swapTx: { txHash: opportunity.swapTx.txHash, amountIn: opportunity.swapTx.amountIn.toString() },
      },
      'Arbitrage opportunity detected!',
    );
    // Phase 4: bundle builder will be called here
  });

  logger.info('Phase 3 active ✓ — detecting arbitrage opportunities');

  await new Promise<void>(() => undefined); // keeps process alive — removed in Phase 5
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console -- logger may not be initialised at fatal startup failure
  console.error('Fatal startup error:', err);
  process.exit(1);
});
