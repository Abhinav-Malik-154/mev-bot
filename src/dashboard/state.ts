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
import type { ArbitrageOpportunity, BundleResult, MetricsSummary } from '../types/index.js';

// ── Public types ─────────────────────────────────────────────────────────────

export interface RecentOpportunity {
  readonly id: string;
  readonly timestamp: number;
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
  readonly walletAddress: string;
  readonly uptimeSeconds: number;
  readonly txScanned: number;
  readonly opportunitiesFound: number;
  readonly bundlesSubmitted: number;
  readonly bundlesIncluded: number;
  readonly successRate: string;
  readonly totalProfitEth: string;
  readonly recentOpportunities: RecentOpportunity[];
  readonly recentBundles: RecentBundle[];
  readonly lastUpdated: number;
}

// ── State manager ─────────────────────────────────────────────────────────────

class DashboardStateManager {
  private state: DashboardState = {
    botStatus: 'starting',
    chainId: 0,
    walletAddress: '',
    uptimeSeconds: 0,
    txScanned: 0,
    opportunitiesFound: 0,
    bundlesSubmitted: 0,
    bundlesIncluded: 0,
    successRate: '0.00%',
    totalProfitEth: '0.000000',
    recentOpportunities: [],
    recentBundles: [],
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

  /** Sets the overall bot status visible in the dashboard header */
  setBotStatus(status: DashboardState['botStatus']): void {
    this.state = { ...this.state, botStatus: status, lastUpdated: Date.now() };
  }

  /** Stores the executor wallet address and chain ID for the header bar */
  setWalletInfo(address: string, chainId: number): void {
    this.state = { ...this.state, walletAddress: address, chainId, lastUpdated: Date.now() };
  }
}

export const dashboardState = new DashboardStateManager();
