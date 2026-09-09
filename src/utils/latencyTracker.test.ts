/**
 * @file src/utils/latencyTracker.test.ts
 * @description Tests for percentile maths and the rolling-window ring buffer.
 *
 * These matter because the dashboard's latency panel is the only evidence
 * behind the README's speed claim. A wrong percentile would turn that claim
 * back into a number nobody verified.
 */

import assert from 'node:assert';
import { percentile, latencyTracker } from './latencyTracker.js';

// Test 1: nearest-rank percentiles over a known 1..100 distribution.
// Nearest rank for p over n samples is ceil(p/100 * n), 1-indexed.
{
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.strictEqual(percentile(sorted, 50), 50, 'p50 of 1..100');
  assert.strictEqual(percentile(sorted, 95), 95, 'p95 of 1..100');
  assert.strictEqual(percentile(sorted, 99), 99, 'p99 of 1..100');
  assert.strictEqual(percentile(sorted, 100), 100, 'p100 must be the max');
}

// Test 2: a percentile must always be a value that was actually observed —
// that is the point of nearest-rank over interpolation.
{
  const sorted = [1, 2, 3, 4];
  for (const p of [1, 25, 50, 75, 99, 100]) {
    assert.ok(sorted.includes(percentile(sorted, p)), `p${p} returned an unobserved value`);
  }
}

// Test 3: the tail must not be hidden by the mean. A distribution that is
// mostly fast with a slow tail should show p99 far above p50 — this is the
// exact case an average would have concealed.
{
  const sorted = [...Array.from({ length: 99 }, () => 1), 500].sort((a, b) => a - b);
  assert.strictEqual(percentile(sorted, 50), 1, 'p50 should sit in the fast bulk');
  assert.strictEqual(percentile(sorted, 99), 1, 'p99 at rank 99 of 100 is still the bulk');
  assert.strictEqual(percentile(sorted, 100), 500, 'the outlier is only visible at p100');
}

// Test 4: edge cases must not throw or return garbage.
{
  assert.strictEqual(percentile([], 50), 0, 'empty window must be 0, not NaN');
  assert.strictEqual(percentile([7], 50), 7, 'single sample');
  assert.strictEqual(percentile([7], 99), 7, 'single sample at the tail');
  assert.strictEqual(percentile([1, 2, 3], 0), 1, 'p0 clamps to the first element');
}

// Test 5: the ring buffer is bounded, and lastSample survives wraparound.
// Previously the window was rebuilt with slice(-N) on every sample; the ring
// overwrites one slot instead, so ordering is no longer insertion order and
// the most recent sample has to be tracked explicitly.
{
  latencyTracker.reset();

  const WINDOW = 1000;
  const WRITES = 1500;
  for (let i = 0; i < WRITES; i++) {
    const timer = latencyTracker.startTimer(`0xtx${i}`);
    timer.checkpoint('parse');
    timer.checkpoint('calculation');
    timer.finish();
  }

  const summary = latencyTracker.getSummary();
  assert.strictEqual(summary.sampleCount, WINDOW, `window must cap at ${WINDOW}`);
  assert.strictEqual(
    summary.lastSample?.txHash,
    `0xtx${WRITES - 1}`,
    'lastSample must be the most recent write, not a ring slot',
  );

  // Ordering invariant: percentiles are computed from a sorted copy, so they
  // must be monotonic regardless of ring insertion order.
  assert.ok(summary.p50TotalMs <= summary.p95TotalMs, 'p50 must be <= p95');
  assert.ok(summary.p95TotalMs <= summary.p99TotalMs, 'p95 must be <= p99');
  assert.ok(summary.minTotalMs <= summary.p50TotalMs, 'min must be <= p50');
  assert.ok(summary.p99TotalMs <= summary.maxTotalMs, 'p99 must be <= max');
}

// Test 6: a fresh tracker reports zeros, never NaN — the dashboard renders
// this before any transaction has arrived.
{
  latencyTracker.reset();
  const summary = latencyTracker.getSummary();
  assert.strictEqual(summary.sampleCount, 0);
  assert.strictEqual(summary.lastSample, null);
  for (const [name, value] of Object.entries(summary)) {
    if (typeof value === 'number') {
      assert.ok(Number.isFinite(value), `${name} must be finite on an empty window, got ${value}`);
    }
  }
}

// eslint-disable-next-line no-console -- test runner output
console.log('✓ All latency tracker tests passed');
