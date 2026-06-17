/**
 * @file src/utils/metrics.ts
 * @description In-memory performance metrics tracker.
 *
 * Tracks bot activity in real-time: transactions scanned,
 * opportunities detected, bundles submitted, profit earned.
 * Automatically logs a summary at a configurable interval.
 * The dashboard reads from this singleton to show live stats.
 */

import { formatEther } from 'ethers';
import { createModuleLogger } from './logger.js';
import type { MetricsSummary } from '../types/index.js';

const logger = createModuleLogger('metrics');

class BotMetrics {
  private txScanned = 0;
  private opportunitiesFound = 0;
  private bundlesSubmitted = 0;
  private totalProfitWei = 0n;
  private readonly startTime = Date.now();
  private intervalHandle: NodeJS.Timeout | undefined = undefined;

  incrementTxScanned(): void {
    this.txScanned += 1;
  }

  incrementOpportunityFound(): void {
    this.opportunitiesFound += 1;
  }

  incrementBundleSubmitted(): void {
    this.bundlesSubmitted += 1;
  }

  addProfit(wei: bigint): void {
    this.totalProfitWei += wei;
  }

  getSummary(): MetricsSummary {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    const totalProfitEth = parseFloat(formatEther(this.totalProfitWei)).toFixed(6);
    const successRate =
      this.opportunitiesFound === 0
        ? '0.00%'
        : `${((this.bundlesSubmitted / this.opportunitiesFound) * 100).toFixed(2)}%`;

    return {
      uptimeSeconds,
      txScanned: this.txScanned,
      opportunitiesFound: this.opportunitiesFound,
      bundlesSubmitted: this.bundlesSubmitted,
      totalProfitWei: this.totalProfitWei,
      totalProfitEth,
      successRate,
    };
  }

  startAutoLog(intervalMs: number): void {
    this.intervalHandle = setInterval((): void => {
      const summary = this.getSummary();
      logger.info(
        {
          uptimeSeconds: summary.uptimeSeconds,
          txScanned: summary.txScanned,
          opportunitiesFound: summary.opportunitiesFound,
          bundlesSubmitted: summary.bundlesSubmitted,
          totalProfitEth: summary.totalProfitEth,
          successRate: summary.successRate,
        },
        'Bot metrics',
      );
    }, intervalMs);
  }

  stopAutoLog(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }
}

export const metrics = new BotMetrics();
