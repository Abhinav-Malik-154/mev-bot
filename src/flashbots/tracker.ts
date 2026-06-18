/**
 * @file src/flashbots/tracker.ts
 * @description Bundle inclusion tracker and performance monitor.
 *
 * Records every submitted bundle and its on-chain outcome.
 * Calculates success rate, cumulative profit, and average blocks
 * to inclusion — metrics used by the dashboard and strategy tuner.
 *
 * Also detects consistent outbidding: if the last 10 bundles all
 * failed to land, the bot should either raise its priority fee or
 * reassess whether it has a competitive edge on that opportunity type.
 *
 * All BigInt values are stored as-is. The ETH conversion for display
 * uses formatEther from ethers and is never fed back into calculations.
 */

import { formatEther } from 'ethers';
import { createModuleLogger } from '../utils/logger.js';
import type { BundleResult } from '../types/index.js';

const logger = createModuleLogger('tracker');

// Outbid detection threshold: if this many consecutive bundles all fail, flag it
const OUTBID_DETECTION_WINDOW = 10;

interface TrackedBundle {
  readonly id: string;
  readonly submittedAt: number;
  readonly targetBlock: number;
  result: BundleResult | undefined;
  resolvedAt: number | undefined;
}

export interface BundleStats {
  readonly totalSubmitted: number;
  readonly totalIncluded: number;
  readonly totalFailed: number;
  readonly successRate: string;
  readonly totalProfitWei: bigint;
  readonly totalProfitEth: string;
  readonly avgBlocksToInclusion: number;
}

export class BundleTracker {
  private readonly bundles = new Map<string, TrackedBundle>();
  private totalProfitWei = 0n;

  /**
   * Records a newly submitted bundle for tracking.
   * Call this immediately after sending to the relay.
   */
  trackSubmission(id: string, targetBlock: number): void {
    this.bundles.set(id, {
      id,
      submittedAt: Date.now(),
      targetBlock,
      result: undefined,
      resolvedAt: undefined,
    });
    logger.debug({ id, targetBlock }, 'Bundle submission tracked');
  }

  /**
   * Records the on-chain result of a previously tracked bundle.
   * Accumulates profit only for successful inclusions.
   */
  recordResult(id: string, result: BundleResult): void {
    const tracked = this.bundles.get(id);
    if (tracked === undefined) {
      logger.warn({ id }, 'recordResult called for unknown bundle id');
      return;
    }
    tracked.result = result;
    tracked.resolvedAt = Date.now();

    if (result.success) {
      this.totalProfitWei += result.profitWei;
    }

    logger.debug(
      {
        id,
        success: result.success,
        blockNumber: result.blockNumber,
        profitWei: result.profitWei.toString(),
      },
      'Bundle result recorded',
    );
  }

  /**
   * Returns aggregated performance statistics across all tracked bundles.
   * successRate is a percentage string, e.g. "42.86%".
   * avgBlocksToInclusion is 0 when no bundles have been included yet.
   */
  getStats(): BundleStats {
    let totalIncluded = 0;
    let totalFailed = 0;
    let blocksToInclusionSum = 0;

    for (const bundle of this.bundles.values()) {
      if (bundle.result === undefined) continue; // still pending
      if (bundle.result.success) {
        totalIncluded += 1;
        blocksToInclusionSum += bundle.result.blockNumber - bundle.targetBlock + 1;
      } else {
        totalFailed += 1;
      }
    }

    const totalResolved = totalIncluded + totalFailed;
    const successRate =
      totalResolved === 0
        ? '0.00%'
        : `${((totalIncluded / totalResolved) * 100).toFixed(2)}%`;

    const avgBlocksToInclusion =
      totalIncluded === 0 ? 0 : Math.round(blocksToInclusionSum / totalIncluded);

    return {
      totalSubmitted: this.bundles.size,
      totalIncluded,
      totalFailed,
      successRate,
      totalProfitWei: this.totalProfitWei,
      totalProfitEth: parseFloat(formatEther(this.totalProfitWei)).toFixed(6),
      avgBlocksToInclusion,
    };
  }

  /**
   * Returns the most recently resolved bundles up to `limit`, newest first.
   * Pending (unresolved) bundles are excluded.
   */
  getRecentBundles(limit: number): TrackedBundle[] {
    return [...this.bundles.values()]
      .filter((b) => b.resolvedAt !== undefined)
      .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
      .slice(0, limit);
  }

  /**
   * Returns true if the last OUTBID_DETECTION_WINDOW resolved bundles all failed.
   * Signals that a competitor is consistently winning the same opportunity,
   * and the bot should raise its priority fee or exit the strategy.
   */
  isConsistentlyOutbid(): boolean {
    const recentResolved = this.getRecentBundles(OUTBID_DETECTION_WINDOW);
    if (recentResolved.length < OUTBID_DETECTION_WINDOW) return false;
    const allFailed = recentResolved.every(
      (b) => b.result !== undefined && !b.result.success,
    );
    if (allFailed) {
      logger.warn(
        { window: OUTBID_DETECTION_WINDOW },
        'Consistently outbid — consider raising priority fee or reassessing strategy',
      );
    }
    return allFailed;
  }
}

export const bundleTracker = new BundleTracker();
