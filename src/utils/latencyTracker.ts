/**
 * @file src/utils/latencyTracker.ts
 * @description Tracks per-transaction pipeline latency.
 *
 * Uses process.hrtime.bigint() for nanosecond-precision timing —
 * far more accurate than Date.now() for measuring sub-millisecond
 * pipeline stages. Keeps a rolling window of the last 100 samples
 * to compute live averages without unbounded memory growth.
 */

import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('latency');
const ROLLING_WINDOW_SIZE = 100;

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
  avgParseMs: number;
  avgCalculationMs: number;
  sampleCount: number;
  lastSample: LatencySample | null;
}

/** Nanoseconds per millisecond — hrtime.bigint() returns ns. */
const NS_PER_MS = 1_000_000;

class LatencyTracker {
  private samples: LatencySample[] = [];

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

      this.samples.push(sample);
      if (this.samples.length > ROLLING_WINDOW_SIZE) {
        this.samples = this.samples.slice(-ROLLING_WINDOW_SIZE);
      }

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
   * Returns rolling averages, min/max, and the most recent sample over the
   * current window. Returns a zeroed summary when no samples exist yet.
   */
  getSummary(): LatencySummary {
    const count = this.samples.length;
    if (count === 0) {
      return {
        avgTotalMs: 0,
        minTotalMs: 0,
        maxTotalMs: 0,
        avgParseMs: 0,
        avgCalculationMs: 0,
        sampleCount: 0,
        lastSample: null,
      };
    }

    let totalSum = 0;
    let parseSum = 0;
    let calcSum = 0;
    let minTotal = this.samples[0]!.totalMs;
    let maxTotal = this.samples[0]!.totalMs;

    for (const s of this.samples) {
      totalSum += s.totalMs;
      parseSum += s.parseMs;
      calcSum += s.calculationMs;
      if (s.totalMs < minTotal) minTotal = s.totalMs;
      if (s.totalMs > maxTotal) maxTotal = s.totalMs;
    }

    return {
      avgTotalMs: totalSum / count,
      minTotalMs: minTotal,
      maxTotalMs: maxTotal,
      avgParseMs: parseSum / count,
      avgCalculationMs: calcSum / count,
      sampleCount: count,
      lastSample: this.samples[count - 1]!,
    };
  }
}

export const latencyTracker = new LatencyTracker();
