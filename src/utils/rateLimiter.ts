/**
 * @file src/utils/rateLimiter.ts
 * @description Sliding-window backoff for RPC rate limit errors.
 *
 * Tracks recent 429 responses. When too many occur in a short window,
 * forces a pause before allowing further calls — prevents hammering an
 * already-rate-limited endpoint and getting further throttled or banned.
 *
 * ## Why the pause is a shared deadline, not a per-caller sleep
 * The mempool subscription spawns one detached task per pending transaction,
 * and at mainnet volume that is hundreds in flight at once. The original
 * design had every one of them independently `setTimeout(pauseMs)` on
 * arrival, so they all woke within milliseconds of each other and hit the
 * provider simultaneously — a thundering herd that re-triggered the very
 * limit the pause existed to escape.
 *
 * Instead, crossing the threshold sets one shared `pausedUntil` deadline and
 * each caller waits until that instant *plus its own random jitter*, so
 * resumption is spread over a window rather than landing on a single
 * millisecond. Repeated throttling escalates the pause exponentially (capped),
 * because a flat pause against a provider that is still limiting just repeats
 * the same collision.
 */

/**
 * The distinct error shapes ethers v6 can surface for an HTTP 429, depending
 * on whether the limit was reported at the transport layer or inside the
 * JSON-RPC body. Fault injection rotates through all of them so every branch
 * of `isRateLimitError` is exercised on the live path, not just the one shape
 * a given provider happens to emit.
 */
const INJECTED_FAULT_SHAPES: ReadonlyArray<(message: string) => Error> = [
  // 1. numeric HTTP status on the error itself
  (message): Error => Object.assign(new Error(message), { code: 429 }),
  // 2. FetchResponse-style status
  (message): Error => Object.assign(new Error(message), { status: 429 }),
  // 3. status nested under ethers' `info` wrapper
  (message): Error => Object.assign(new Error(message), { info: { status: 429 } }),
  // 4. JSON-RPC error object
  (message): Error => Object.assign(new Error(message), { info: { error: { code: 429 } } }),
  // 5. textual only — Alchemy's compute-unit message, no numeric code anywhere
  (): Error => new Error('injected fault: your app has exceeded its compute units per second capacity'),
];

export class RateLimitBackoff {
  private recent429s: number[] = [];
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly pauseMs: number;
  private readonly maxPauseMs: number;

  /** Shared wall-clock instant every caller waits for. 0 means "not paused". */
  private pausedUntil = 0;
  /** Consecutive threshold crossings, driving the exponential escalation. */
  private escalation = 0;
  /** Round-robin cursor over INJECTED_FAULT_SHAPES. */
  private injectionCursor = 0;
  /** Probability (0..1) of injecting a synthetic 429. 0 disables injection. */
  private faultRate = 0;

  constructor(windowMs = 5000, threshold = 3, pauseMs = 1000, maxPauseMs = 15000) {
    this.windowMs = windowMs;
    this.threshold = threshold;
    this.pauseMs = pauseMs;
    this.maxPauseMs = maxPauseMs;
  }

  /**
   * Sets the fault-injection probability (0..1). Wired from
   * `config.injectFaultRate` at startup, and used directly by tests.
   *
   * Injected here rather than read from config inside this module so this
   * stays a dependency-free leaf utility — importing it must not require a
   * fully populated environment.
   */
  setFaultRate(rate: number): void {
    this.faultRate = rate;
    this.injectionCursor = 0;
  }

  /**
   * Throws a synthetic, realistically-shaped 429 with probability `faultRate`.
   *
   * Called at the top of `waitIfNeeded`, which every guarded RPC call site
   * already awaits inside its own try/catch — so one injection point
   * exercises every recovery path in the bot. Shapes rotate so each branch of
   * `isRateLimitError` gets hit in turn.
   */
  private maybeInjectFault(): void {
    if (this.faultRate <= 0 || Math.random() >= this.faultRate) return;

    const shape = INJECTED_FAULT_SHAPES[this.injectionCursor % INJECTED_FAULT_SHAPES.length];
    this.injectionCursor += 1;
    if (shape === undefined) return;

    const error = shape('injected fault: server responded with 429 Too Many Requests');
    // Marks the error as synthetic for anything that wants to tell it apart
    // from genuine provider throttling.
    throw Object.assign(error, { injected: true });
  }

  /** Drops timestamps older than the sliding window. */
  private trim(now: number): void {
    const cutoff = now - this.windowMs;
    // recent429s is append-only in time order, so the survivors are a suffix.
    let firstFresh = 0;
    while (firstFresh < this.recent429s.length && (this.recent429s[firstFresh] ?? 0) < cutoff) {
      firstFresh += 1;
    }
    if (firstFresh > 0) this.recent429s = this.recent429s.slice(firstFresh);
  }

  /**
   * Records that a rate-limit (429) response was just observed.
   *
   * Crossing the threshold arms a single shared pause deadline that all
   * callers observe. Escalation is exponential and capped: a flat pause
   * against a provider that is still throttling would just reproduce the
   * same collision a second later.
   */
  recordRateLimit(): void {
    const now = Date.now();
    this.recent429s.push(now);
    this.trim(now);

    if (this.recent429s.length < this.threshold) return;

    this.escalation += 1;
    const backoffMs = Math.min(this.pauseMs * 2 ** (this.escalation - 1), this.maxPauseMs);
    // Never pull an existing deadline earlier.
    this.pausedUntil = Math.max(this.pausedUntil, now + backoffMs);
  }

  /**
   * Awaited before each outbound RPC call.
   *
   * Waits until the shared pause deadline plus per-caller random jitter, so
   * hundreds of concurrent tasks resume spread across a window instead of all
   * on the same millisecond. Returns immediately when no pause is armed.
   *
   * May throw a synthetic 429 when fault injection is enabled — deliberately,
   * so callers' recovery paths get exercised.
   */
  async waitIfNeeded(): Promise<void> {
    this.maybeInjectFault();

    const now = Date.now();
    this.trim(now);

    if (now >= this.pausedUntil) {
      // Clean for a full window past the last pause: stand the escalation down.
      if (this.pausedUntil !== 0 && now - this.pausedUntil >= this.windowMs) {
        this.escalation = 0;
        this.pausedUntil = 0;
      }
      return;
    }

    const jitterMs = Math.random() * this.pauseMs;
    const delayMs = this.pausedUntil - now + jitterMs;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  /** Milliseconds remaining on the shared pause; 0 when not paused. */
  get pauseRemainingMs(): number {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  /** Clears all state. Used by tests. */
  reset(): void {
    this.recent429s = [];
    this.pausedUntil = 0;
    this.escalation = 0;
    this.injectionCursor = 0;
    this.faultRate = 0;
  }

  /** Number of 429s currently inside the sliding window (for tests/inspection). */
  get recentCount(): number {
    this.trim(Date.now());
    return this.recent429s.length;
  }

  /**
   * Detects whether an unknown thrown value is an RPC rate-limit (HTTP 429).
   *
   * ethers v6 surfaces throttling in several shapes depending on whether the
   * limit was reported at the HTTP layer or inside the JSON-RPC body, so we
   * check all of them:
   *   - err.code === 429                     (numeric HTTP status on the error)
   *   - err.status === 429                   (FetchResponse-style status)
   *   - err.info.error.code === 429          (JSON-RPC error object)
   *   - err.info.status === 429              (ethers wraps the response status here)
   *   - message contains "429" / "rate limit" / "compute unit" / "too many requests"
   *     (Alchemy's textual limit messages)
   */
  isRateLimitError(error: unknown): boolean {
    if (error === null || typeof error !== 'object') return false;

    const err = error as {
      code?: unknown;
      status?: unknown;
      shortMessage?: unknown;
      message?: unknown;
      info?: { status?: unknown; error?: { code?: unknown } };
    };

    if (err.code === 429 || err.code === '429') return true;
    if (err.status === 429) return true;
    if (err.info?.status === 429) return true;
    if (err.info?.error?.code === 429) return true;

    const text = `${String(err.shortMessage ?? '')} ${String(err.message ?? '')}`.toLowerCase();
    if (
      text.includes('429') ||
      text.includes('too many requests') ||
      text.includes('rate limit') ||
      text.includes('compute unit') ||
      text.includes('exceeded its')
    ) {
      return true;
    }

    return false;
  }
}

export const rateLimitBackoff = new RateLimitBackoff();
