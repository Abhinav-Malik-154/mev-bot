/**
 * @file src/dashboard/state.ts
 * @description Shared state manager for dashboard data.
 *
 * Acts as an in-memory store that the bot updates as events happen.
 * The WebSocket server reads from this state to push updates to clients.
 * Decoupled from the HTTP server so state can be updated from anywhere
 * in the pipeline (mempool monitor, detector, executor, relay).
 *
 * All bigint values from the core types are converted to formatted ETH
 * strings here so the state is safely JSON-serialisable.
 */

import { formatEther } from 'ethers';
import type {
  ArbitrageOpportunity,
  ArbitrageStrategy,
  BundleResult,
  MetricsSummary,
} from '../types/index.js';
import type { LatencySummary } from '../utils/latencyTracker.js';

// ── Public types ─────────────────────────────────────────────────────────────

export interface RecentOpportunity {
  readonly id: string;
  readonly timestamp: number;
  /** Which detector produced this: 'v2-v2', 'v2-v3' or 'triangular' */
  readonly strategyType: ArbitrageStrategy;
  /** True when fabricated by the test harness rather than detected on-chain. */
  readonly synthetic: boolean;
  readonly tokenA: string;
  readonly tokenB: string;
  /** Net profit formatted to 6 decimal places in ETH (may be negative) */
  readonly netProfitEth: string;
  readonly isProfitable: boolean;
  /** Confidence score 0.0–1.0 */
  readonly confidence: number;
}

export interface RecentBundle {
  readonly id: string;
  readonly timestamp: number;
  readonly success: boolean;
  /** Profit formatted to 6 decimal places in ETH */
  readonly profitEth: string;
  readonly bundleHash: string | null;
  readonly error: string | undefined;
}

export interface DashboardState {
  readonly botStatus: 'starting' | 'running' | 'error' | 'stopped';
  readonly chainId: number;
  /** True when the bot is in read-only observation mode (no submissions). */
  readonly readOnlyMode: boolean;
  readonly walletAddress: string;
  readonly uptimeSeconds: number;
  readonly txScanned: number;
  readonly opportunitiesFound: number;
  readonly bundlesSubmitted: number;
  /** RPC rate-limit (HTTP 429) errors caught and survived without crashing */
  readonly rateLimitErrors: number;
  readonly bundlesIncluded: number;
  readonly successRate: string;
  readonly totalProfitEth: string;
  readonly recentOpportunities: RecentOpportunity[];
  readonly recentBundles: RecentBundle[];
  readonly latency: {
    avgTotalMs: number;
    /** Median — the typical case. */
    p50TotalMs: number;
    /** 95th percentile — one transaction in twenty is slower than this. */
    p95TotalMs: number;
    /** 99th percentile — the tail that loses blocks to competitors. */
    p99TotalMs: number;
    sampleCount: number;
  };
  readonly lastUpdated: number;
}

// ── State manager ─────────────────────────────────────────────────────────────

class DashboardStateManager {
  private state: DashboardState = {
    botStatus: 'starting',
    chainId: 0,
    readOnlyMode: false,
    walletAddress: '',
    uptimeSeconds: 0,
    txScanned: 0,
    opportunitiesFound: 0,
    bundlesSubmitted: 0,
    rateLimitErrors: 0,
    bundlesIncluded: 0,
    successRate: '0.00%',
    totalProfitEth: '0.000000',
    recentOpportunities: [],
    recentBundles: [],
    latency: {
      avgTotalMs: 0,
      p50TotalMs: 0,
      p95TotalMs: 0,
      p99TotalMs: 0,
      sampleCount: 0,
    },
    lastUpdated: Date.now(),
  };

  private readonly maxRecentItems = 50;

  /** Returns a snapshot of the current dashboard state */
  getState(): DashboardState {
    return this.state;
  }

  /**
   * Updates the metrics-derived fields from the latest bot metrics summary.
   * Does not touch bundlesSubmitted/bundlesIncluded — those are managed
   * by addBundle() to avoid double-counting.
   */
  updateMetrics(summary: MetricsSummary): void {
    this.state = {
      ...this.state,
      txScanned: summary.txScanned,
      opportunitiesFound: summary.opportunitiesFound,
      rateLimitErrors: summary.rateLimitErrors,
      uptimeSeconds: summary.uptimeSeconds,
      totalProfitEth: summary.totalProfitEth,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Prepends a new opportunity to the recent list (capped at maxRecentItems).
   * Converts bigint netProfitWei to a 6-decimal ETH string for serialisation.
   */
  addOpportunity(opp: ArbitrageOpportunity): void {
    const recent: RecentOpportunity = {
      id: opp.id,
      timestamp: opp.timestamp,
      strategyType: opp.strategyType,
      synthetic: opp.synthetic,
      tokenA: opp.tokenA,
      tokenB: opp.tokenB,
      netProfitEth: parseFloat(formatEther(opp.netProfitWei)).toFixed(6),
      isProfitable: opp.isProfitable,
      confidence: opp.confidence,
    };

    const updated = [recent, ...this.state.recentOpportunities].slice(0, this.maxRecentItems);
    this.state = {
      ...this.state,
      recentOpportunities: updated,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Prepends a new bundle result and recalculates bundlesSubmitted,
   * bundlesIncluded, and successRate.
   */
  addBundle(result: BundleResult & { id: string }): void {
    const recent: RecentBundle = {
      id: result.id,
      timestamp: Date.now(),
      success: result.success,
      profitEth: parseFloat(formatEther(result.profitWei)).toFixed(6),
      bundleHash: result.bundleHash,
      error: result.error,
    };

    const updatedBundles = [recent, ...this.state.recentBundles].slice(0, this.maxRecentItems);
    const bundlesSubmitted = this.state.bundlesSubmitted + 1;
    const bundlesIncluded = this.state.bundlesIncluded + (result.success ? 1 : 0);
    const successRate =
      bundlesSubmitted === 0
        ? '0.00%'
        : `${((bundlesIncluded / bundlesSubmitted) * 100).toFixed(2)}%`;

    this.state = {
      ...this.state,
      recentBundles: updatedBundles,
      bundlesSubmitted,
      bundlesIncluded,
      successRate,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Updates the live latency panel from the tracker's rolling summary.
   * Only carries the fields the dashboard renders; parse/calculation
   * averages stay internal to the tracker.
   *
   * Surfaces percentiles rather than min/max. `min` is the best case and
   * tells us nothing useful, and `max` is a single outlier one GC pause can
   * dominate — whereas p95/p99 show how often we are too slow, which is
   * what decides whether a competitor beats us to the block.
   */
  updateLatency(summary: LatencySummary): void {
    this.state = {
      ...this.state,
      latency: {
        avgTotalMs: summary.avgTotalMs,
        p50TotalMs: summary.p50TotalMs,
        p95TotalMs: summary.p95TotalMs,
        p99TotalMs: summary.p99TotalMs,
        sampleCount: summary.sampleCount,
      },
      lastUpdated: Date.now(),
    };
  }

  /** Sets the overall bot status visible in the dashboard header */
  setBotStatus(status: DashboardState['botStatus']): void {
    this.state = { ...this.state, botStatus: status, lastUpdated: Date.now() };
  }

  /** Stores the executor wallet address and chain ID for the header bar */
  setWalletInfo(address: string, chainId: number): void {
    this.state = { ...this.state, walletAddress: address, chainId, lastUpdated: Date.now() };
  }

  /**
   * Records whether the bot is running in read-only observation mode, so the
   * dashboard can surface an unmistakable badge instead of implying live trading.
   */
  setReadOnlyMode(readOnlyMode: boolean): void {
    this.state = { ...this.state, readOnlyMode, lastUpdated: Date.now() };
  }
}

export const dashboardState = new DashboardStateManager();
