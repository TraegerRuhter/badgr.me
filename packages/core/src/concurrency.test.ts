import { describe, expect, it, vi } from "vitest";
import { createCoalescedRunner } from "./concurrency";

/** A deferred promise so tests control exactly when a run settles. */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createCoalescedRunner", () => {
  it("runs the task when idle", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const run = createCoalescedRunner(task);
    await run();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("collapses calls during an in-flight run into a single trailing run", async () => {
    const gates = [deferred(), deferred()];
    let call = 0;
    const task = vi.fn().mockImplementation(() => gates[call++].promise);

    const run = createCoalescedRunner(task);
    run(); // starts run #1
    // three more calls while #1 is in flight → at most ONE trailing run
    run();
    run();
    run();
    expect(task).toHaveBeenCalledTimes(1);

    gates[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(2); // exactly one trailing run

    gates[1].resolve();
    await gates[1].promise;
  });

  it("does not start a trailing run when none was requested mid-flight", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const run = createCoalescedRunner(task);
    await run();
    await run(); // sequential, not concurrent
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("recovers after a rejected run instead of wedging", async () => {
    const task = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);

    const run = createCoalescedRunner(task);
    await run(); // first rejects internally, must not throw or wedge
    await run(); // should still be able to run again
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("never lets two runs overlap", async () => {
    let active = 0;
    let maxActive = 0;
    const task = vi.fn().mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    });

    const run = createCoalescedRunner(task);
    await Promise.all([run(), run(), run(), run()]);
    expect(maxActive).toBe(1);
  });
});
