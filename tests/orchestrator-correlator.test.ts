/**
 * RequestCorrelator — requestId correlation, resolve, timeout, reject, cancel.
 *
 * Uses injected scheduler/clearer so we don't depend on real wall-clock time.
 */
import { test, assert } from "./helpers.ts";
import { RequestCorrelator } from "../src/orchestrator/correlator.ts";

function makeFakeClock() {
  let t = 0;
  const timers = new Map<number, { fn: () => void; fireAt: number }>();
  let nextHandle = 1;
  const now = () => t;
  const scheduler = (fn: () => void, ms: number) => {
    const handle = nextHandle++;
    timers.set(handle, { fn, fireAt: t + ms });
    return handle as unknown as ReturnType<typeof setTimeout>;
  };
  const clearer = (h: ReturnType<typeof setTimeout>) => {
    timers.delete(h as unknown as number);
  };
  const advance = (ms: number) => {
    t += ms;
    for (const [handle, entry] of [...timers]) {
      if (entry.fireAt <= t) {
        timers.delete(handle);
        entry.fn();
      }
    }
  };
  return { now, scheduler, clearer, advance, pending: () => timers.size };
}

test("correlator: register + resolve yields the value", async () => {
  const c = new RequestCorrelator<string>();
  const p = c.register("r1");
  c.resolve("r1", "ok");
  assert.equal(await p, "ok");
  assert.equal(c.has("r1"), false);
});

test("correlator: reject propagates the error", async () => {
  const c = new RequestCorrelator<string>();
  const p = c.register("r1");
  c.reject("r1", "boom");
  await assert.rejects(() => p, /boom/);
});

test("correlator: resolve on an unknown id is a no-op", () => {
  const c = new RequestCorrelator<string>();
  assert.equal(c.resolve("nope", "x"), false);
  assert.equal(c.reject("nope", "x"), false);
});

test("correlator: register twice with same id rejects the second", async () => {
  const clock = makeFakeClock();
  const c = new RequestCorrelator<string>({
    now: clock.now,
    scheduler: clock.scheduler,
    clearer: clock.clearer,
  });
  c.register("r1"); // pending, but the fake clock never fires it
  await assert.rejects(() => c.register("r1"), /déjà en cours/);
});

test("correlator: timeout rejects when the deadline passes (fake clock)", async () => {
  const clock = makeFakeClock();
  const c = new RequestCorrelator<string>({
    defaultTimeoutMs: 1000,
    now: clock.now,
    scheduler: clock.scheduler,
    clearer: clock.clearer,
  });
  const p = c.register("r1");
  assert.equal(c.size, 1);
  clock.advance(999);
  assert.equal(c.size, 1); // not yet
  clock.advance(2);
  await assert.rejects(() => p, /Délai dépassé/);
  assert.equal(c.size, 0);
});

test("correlator: resolving clears the timeout (no late reject)", async () => {
  const clock = makeFakeClock();
  const c = new RequestCorrelator<string>({
    defaultTimeoutMs: 1000,
    now: clock.now,
    scheduler: clock.scheduler,
    clearer: clock.clearer,
  });
  const p = c.register("r1");
  c.resolve("r1", "ok");
  clock.advance(2000); // would have fired
  assert.equal(await p, "ok");
  assert.equal(clock.pending(), 0);
});

test("correlator: cancelAll rejects every pending request", async () => {
  const c = new RequestCorrelator<string>();
  const p1 = c.register("a");
  const p2 = c.register("b");
  c.cancelAll("aborted");
  await assert.rejects(() => p1, /aborted/);
  await assert.rejects(() => p2, /aborted/);
  assert.equal(c.size, 0);
});
