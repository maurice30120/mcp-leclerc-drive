/**
 * Request correlator — correlates an async {@link LeclercRequest} with its
 * {@link LeclercResponse} by `requestId`, with a per-request timeout.
 *
 * Used by the isolated-world content relay (extension/content-relay.ts):
 *   - `register(id, ms)` → Promise that resolves with the response data or
 *     rejects on timeout / explicit cancel,
 *   - `resolve(id, data)` / `reject(id, err)` → called when the MAIN bridge
 *     posts back or a timeout fires.
 *
 * Pure TS (only `setTimeout`/`clearTimeout`), no chrome.* — so it is unit
 * tested in `tests/orchestrator-correlator.test.ts` with `node:test` mock
 * timers.
 */

export interface CorrelatorOptions {
  /** Default timeout in ms when `register` omits one. */
  defaultTimeoutMs?: number;
  /** Inject a custom clock (defaults to Date.now). */
  now?: () => number;
  /** Inject a scheduler (defaults to global setTimeout). */
  scheduler?: (fn: () => void, ms: number) => Timer;
  /** Inject a clearer (defaults to global clearTimeout). */
  clearer?: (t: Timer) => void;
}

// `Timer` is whatever setTimeout returns (number in Node, object in browser).
type Timer = ReturnType<typeof setTimeout>;

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: Timer;
  startedAt: number;
}

export class RequestCorrelator<T = unknown> {
  private readonly pending = new Map<string, Pending<T>>();
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private readonly scheduler: (fn: () => void, ms: number) => Timer;
  private readonly clearer: (t: Timer) => void;

  constructor(opts: CorrelatorOptions = {}) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 8000;
    this.now = opts.now ?? (() => Date.now());
    this.scheduler = opts.scheduler ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearer = opts.clearer ?? ((t) => clearTimeout(t as never));
  }

  /** Number of requests currently awaiting a response. */
  get size(): number {
    return this.pending.size;
  }

  /** True if `requestId` is currently pending. */
  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /**
   * Register a pending request and return a promise that resolves with the
   * response payload, or rejects with a timeout error.
   */
  register(requestId: string, timeoutMs?: number): Promise<T> {
    if (this.pending.has(requestId)) {
      return Promise.reject(
        new Error(`requestId déjà en cours : ${requestId}`),
      );
    }
    const ms = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = this.scheduler(() => {
        if (this.pending.delete(requestId)) {
          reject(
            new Error(
              `Délai dépassé pour la requête ${requestId} (${ms} ms) — la page Leclerc n'a pas répondu.`,
            ),
          );
        }
      }, ms);
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        startedAt: this.now(),
      });
    });
  }

  /** Resolve a pending request with `value`. No-op if unknown/expired. */
  resolve(requestId: string, value: T): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    this.clearer(p.timer);
    p.resolve(value);
    return true;
  }

  /** Reject a pending request with `err`. No-op if unknown/expired. */
  reject(requestId: string, err: Error | string): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    this.clearer(p.timer);
    p.reject(err instanceof Error ? err : new Error(err));
    return true;
  }

  /** Cancel every pending request with the given error. */
  cancelAll(err: Error | string = "Correlator annulé"): void {
    for (const [, p] of this.pending) {
      this.clearer(p.timer);
      p.reject(err instanceof Error ? err : new Error(err));
    }
    this.pending.clear();
  }
}
