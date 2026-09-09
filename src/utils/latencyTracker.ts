/**
 * @file src/utils/latencyTracker.ts
 * @description Tracks per-transaction pipeline latency.
 *
 * Uses process.hrtime.bigint() for nanosecond-precision timing —
 * far more accurate than Date.now() for measuring sub-millisecond
 * pipeline stages. Keeps a bounded rolling window of samples so memory
 * never grows without limit.
 *
 * ## Why percentiles, not just an average
 * MEV is a tail-latency game. A competitor takes the opportunity when we
 * are slow on *this* transaction, not when our average looks fine — so the
 * mean hides exactly the failures that cost money. `max` is no substitute
 * either: it is a single worst outlier that one GC pause or network blip
 * can dominate. p95/p99 answer the question that actually matters — how
 * often are we too slow?
 *
 * The window is 1000 samples so p99 is a real percentile. At the previous
 * 100 it aliased onto the single worst sample and told us nothing that
 * max did not already say.
 */

import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('latency');
const ROLLING_WINDOW_SIZE = 1000;

export interface LatencySample {
  txHash: string;
  parseMs: number;
  calculationMs: number;
  totalMs: number;
  timestamp: number;
}

export interface LatencySummary {
  avgTotalMs: number;
  minTotalMs: number;
  maxTotalMs: number;
  /** Median end-to-end latency — the typical case. */
  p50TotalMs: number;
  /** 95th percentile — one transaction in twenty is slower than this. */
  p95TotalMs: number;
  /** 99th percentile — the tail that loses blocks to competitors. */
  p99TotalMs: number;
  avgParseMs: number;
  avgCalculationMs: number;
  sampleCount: number;
  lastSample: LatencySample | null;
}

/**
 * Nearest-rank percentile over an ascending-sorted array.
 *
 * Nearest-rank rather than an interpolating variant is deliberate: it always
 * returns a latency that was genuinely observed, so a reported p99 is a real
 * transaction you can go and look at rather than a number that never
 * actually happened.
 */
export function percentile(sortedAscending: readonly number[], p: number): number {
  const length = sortedAscending.length;
  if (length === 0) return 0;
  const rank = Math.ceil((p / 100) * length);
  const index = Math.min(Math.max(rank - 1, 0), length - 1);
  return sortedAscending[index] ?? 0;
}

/** Nanoseconds per millisecond — hrtime.bigint() returns ns. */
const NS_PER_MS = 1_000_000;

class LatencyTracker {
  /**
   * Fixed-capacity ring buffer. The previous implementation called
   * `slice(-N)` on every sample, reallocating the whole window once per
   * transaction — wasteful on a path that runs hundreds of times a second
   * at mainnet volume. Overwriting a single slot is O(1).
   */
  private samples: LatencySample[] = [];
  private writeIndex = 0;
  private mostRecent: LatencySample | null = null;

  /** Appends into the ring, overwriting the oldest sample once full. */
  private record(sample: LatencySample): void {
    if (this.samples.length < ROLLING_WINDOW_SIZE) {
      this.samples.push(sample);
    } else {
      this.samples[this.writeIndex] = sample;
    }
    this.writeIndex = (this.writeIndex + 1) % ROLLING_WINDOW_SIZE;
    this.mostRecent = sample;
  }

  /**
   * Starts a timing measurement, returns a function to call at each
   * checkpoint. Usage:
   *   const timer = latencyTracker.startTimer(txHash)
   *   ... parse work ...
   *   const parseMs = timer.checkpoint('parse')
   *   ... calculation work ...
   *   const calcMs = timer.checkpoint('calculation')
   *   timer.finish()
   */
  startTimer(txHash: string): {
    checkpoint: (label: string) => number;
    finish: () => LatencySample;
  } {
    const start = process.hrtime.bigint();
    const checkpoints = new Map<string, bigint>();

    const checkpoint = (label: string): number => {
      const now = process.hrtime.bigint();
      checkpoints.set(label, now);
      return Number(now - start) / NS_PER_MS;
    };

    const finish = (): LatencySample => {
      const end = process.hrtime.bigint();
      const parseTime = checkpoints.get('parse') ?? start;
      const calcTime = checkpoints.get('calculation') ?? end;

      const parseMs = Number(parseTime - start) / NS_PER_MS;
      // Calculation stage is measured from the parse checkpoint to the
      // calculation checkpoint — the isolated cost of the detection maths.
      const calculationMs = Number(calcTime - parseTime) / NS_PER_MS;
      const totalMs = Number(end - start) / NS_PER_MS;

      const sample: LatencySample = {
        txHash,
        parseMs,
        calculationMs,
        totalMs,
        timestamp: Date.now(),
      };

      this.record(sample);

      // Debug-only: per-tx samples are high-volume, so never surface at info.
      logger.debug(
        {
          txHash,
          parseMs: parseMs.toFixed(3),
          calculationMs: calculationMs.toFixed(3),
          totalMs: totalMs.toFixed(3),
        },
        'Pipeline latency sample',
      );

      return sample;
    };

    return { checkpoint, finish };
  }

  /**
   * Returns rolling averages, min/max, p50/p95/p99, and the most recent
   * sample over the current window. Returns a zeroed summary when no
   * samples exist yet.
   *
   * Sorting happens here rather than on insert: this runs on the dashboard's
   * 5-second tick, whereas insertion runs per transaction. Keep the cost on
   * the cold path.
   */
  getSummary(): LatencySummary {
    const count = this.samples.length;
    if (count === 0) {
      return {
        avgTotalMs: 0,
        minTotalMs: 0,
        maxTotalMs: 0,
        p50TotalMs: 0,
        p95TotalMs: 0,
        p99TotalMs: 0,
        avgParseMs: 0,
        avgCalculationMs: 0,
        sampleCount: 0,
        lastSample: null,
      };
    }

    let totalSum = 0;
    let parseSum = 0;
    let calcSum = 0;

    for (const s of this.samples) {
      totalSum += s.totalMs;
      parseSum += s.parseMs;
      calcSum += s.calculationMs;
    }

    const sortedTotals = this.samples.map((s) => s.totalMs).sort((a, b) => a - b);

    return {
      avgTotalMs: totalSum / count,
      minTotalMs: sortedTotals[0] ?? 0,
      maxTotalMs: sortedTotals[count - 1] ?? 0,
      p50TotalMs: percentile(sortedTotals, 50),
      p95TotalMs: percentile(sortedTotals, 95),
      p99TotalMs: percentile(sortedTotals, 99),
      avgParseMs: parseSum / count,
      avgCalculationMs: calcSum / count,
      sampleCount: count,
      lastSample: this.mostRecent,
    };
  }

  /** Clears the rolling window. Used by tests. */
  reset(): void {
    this.samples = [];
    this.writeIndex = 0;
    this.mostRecent = null;
  }
}

export const latencyTracker = new LatencyTracker();
