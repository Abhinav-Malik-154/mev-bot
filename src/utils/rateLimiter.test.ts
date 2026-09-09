/**
 * @file src/utils/rateLimiter.test.ts
 * @description Tests for 429 detection, fault injection, and the shared-pause
 * backoff.
 *
 * Detecting a 429 and *surviving* one are different claims. Matching error
 * shapes offline proves only the first. These tests drive the real
 * waitIfNeeded path so the recovery behaviour itself is exercised.
 */

import assert from 'node:assert';
import { RateLimitBackoff } from './rateLimiter.js';

// Test 1: every injected shape must be recognised by isRateLimitError.
// The cursor rotates through all five, so five consecutive injections cover
// each branch — this is the structural claim, proven on the live path.
{
  const rl = new RateLimitBackoff();
  rl.setFaultRate(1); // always inject

  const shapeCount = 5;
  for (let i = 0; i < shapeCount; i++) {
    let caught: unknown;
    try {
      await rl.waitIfNeeded();
      assert.fail(`shape ${i} did not throw`);
    } catch (err: unknown) {
      caught = err;
    }
    assert.ok(
      rl.isRateLimitError(caught),
      `injected shape ${i} was not recognised as a rate-limit error`,
    );
    assert.strictEqual(
      (caught as { injected?: boolean }).injected,
      true,
      `shape ${i} must be marked as synthetic`,
    );
  }
}

// Test 2: injection off means never throws.
{
  const rl = new RateLimitBackoff();
  rl.setFaultRate(0);
  for (let i = 0; i < 20; i++) await rl.waitIfNeeded();
}

// Test 3: real (non-injected) 429 shapes are still detected, and clearly
// non-rate-limit errors are not misclassified as one.
{
  const rl = new RateLimitBackoff();
  const positives: unknown[] = [
    Object.assign(new Error('x'), { code: 429 }),
    Object.assign(new Error('x'), { status: 429 }),
    Object.assign(new Error('x'), { info: { status: 429 } }),
    Object.assign(new Error('x'), { info: { error: { code: 429 } } }),
    new Error('Your app has exceeded its compute units per second capacity'),
    new Error('429 Too Many Requests'),
  ];
  for (const [i, err] of positives.entries()) {
    assert.ok(rl.isRateLimitError(err), `positive ${i} not detected`);
  }

  const negatives: unknown[] = [
    new Error('execution reverted: INSUFFICIENT_OUTPUT_AMOUNT'),
    Object.assign(new Error('nope'), { code: 500 }),
    null,
    undefined,
    'a string',
  ];
  for (const [i, err] of negatives.entries()) {
    assert.ok(!rl.isRateLimitError(err), `negative ${i} wrongly detected as a rate limit`);
  }
}

// Test 4: THE THUNDERING HERD. Many concurrent callers must not all resume on
// the same millisecond. Previously each caller slept a fixed pauseMs from its
// own arrival, so hundreds of detached mempool tasks woke together and
// re-triggered the limit. Now they share a deadline and add their own jitter.
{
  const pauseMs = 120;
  const rl = new RateLimitBackoff(300, 3, pauseMs, 1000);
  rl.setFaultRate(0);

  for (let i = 0; i < 3; i++) rl.recordRateLimit();
  assert.ok(rl.pauseRemainingMs > 0, 'threshold crossing must arm a pause');

  const start = Date.now();
  const resumeTimes: number[] = [];
  await Promise.all(
    Array.from({ length: 60 }, async (): Promise<void> => {
      await rl.waitIfNeeded();
      resumeTimes.push(Date.now() - start);
    }),
  );

  const earliest = Math.min(...resumeTimes);
  const latest = Math.max(...resumeTimes);

  // Everyone honours the shared deadline...
  assert.ok(earliest >= pauseMs - 25, `resumed too early: ${earliest}ms < ${pauseMs}ms`);
  // ...but they do NOT all land together. Jitter spans 0..pauseMs, so across
  // 60 callers the spread should be a large fraction of that.
  assert.ok(
    latest - earliest > pauseMs * 0.25,
    `resume times not spread — herd not broken (spread ${latest - earliest}ms of ${pauseMs}ms)`,
  );
}

// Test 5: repeated throttling escalates the pause exponentially, capped.
// A flat pause against a provider that is still limiting just reproduces the
// same collision a moment later.
{
  const rl = new RateLimitBackoff(5000, 3, 100, 400);
  for (let i = 0; i < 3; i++) rl.recordRateLimit();
  const first = rl.pauseRemainingMs;
  assert.ok(first > 50 && first <= 100, `first backoff should be ~100ms, got ${first}`);

  rl.recordRateLimit();
  const second = rl.pauseRemainingMs;
  assert.ok(second > first, `backoff must escalate: ${second} !> ${first}`);

  for (let i = 0; i < 6; i++) rl.recordRateLimit();
  assert.ok(rl.pauseRemainingMs <= 400, 'escalation must be capped at maxPauseMs');
}

// Test 6: a clean window stands the escalation back down, so one bad burst
// does not permanently slow the bot.
{
  const rl = new RateLimitBackoff(40, 3, 20, 200);
  for (let i = 0; i < 5; i++) rl.recordRateLimit();
  assert.ok(rl.pauseRemainingMs > 0, 'pause should be armed');

  await new Promise((resolve) => setTimeout(resolve, 150));
  await rl.waitIfNeeded(); // observes the clean window and resets

  for (let i = 0; i < 3; i++) rl.recordRateLimit();
  const afterReset = rl.pauseRemainingMs;
  assert.ok(
    afterReset > 0 && afterReset <= 20,
    `escalation should have reset to the base pause, got ${afterReset}ms`,
  );
}

// eslint-disable-next-line no-console -- test runner output
console.log('✓ All rate limiter tests passed');
