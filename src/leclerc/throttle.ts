/**
 * Anti-strike layer for talking to Leclerc Drive.
 *
 * Leclerc Drive is protected by DataDome, which blocks (HTTP 403) traffic that
 * looks automated — in particular bursts of requests fired in parallel. This
 * module makes the client behave like a careful human:
 *
 *  - **Serialization**: all requests go through a single queue, one at a time,
 *    so even if several MCP tool calls arrive "in parallel" they are spaced out
 *    rather than hitting the site at once.
 *  - **Min interval + jitter**: a configurable pause between requests, plus a
 *    small random jitter so the cadence isn't robotic.
 *  - **Retry with backoff**: a 403/429 is retried a few times with exponential
 *    backoff instead of failing immediately.
 */

export interface ThrottleOptions {
  /** Minimum delay between two requests, in ms. */
  minIntervalMs: number;
  /** Extra random delay added on top of the interval, in ms (0..jitterMs). */
  jitterMs: number;
  /** How many times to retry a 403/429 before giving up. */
  maxRetries: number;
  /** Base backoff for retries, in ms (doubles each attempt). */
  backoffBaseMs: number;
}

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Serializes work and spaces it out to stay under DataDome's radar. */
export class Throttler {
  private tail: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(private readonly opts: ThrottleOptions) {}

  /** Queue `fn` after all previously-scheduled work, spacing requests out. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.lastAt + this.opts.minIntervalMs + this.jitter() - Date.now();
      if (wait > 0) await delay(wait);
      try {
        return await fn();
      } finally {
        this.lastAt = Date.now();
      }
    });
    // Keep the chain alive whether this task resolves or rejects.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Backoff delay (with jitter) before retry number `attempt` (1-based). */
  backoff(attempt: number): number {
    return this.opts.backoffBaseMs * 2 ** (attempt - 1) + this.jitter();
  }

  get maxRetries(): number {
    return this.opts.maxRetries;
  }

  private jitter(): number {
    return Math.floor(Math.random() * (this.opts.jitterMs + 1));
  }
}
