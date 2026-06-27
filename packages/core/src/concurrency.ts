/**
 * Wraps an async task so it never runs concurrently with itself. While a run
 * is in flight, additional calls don't start a second run — they set a single
 * "run again when done" flag, so exactly one trailing run happens after the
 * current one. This collapses a burst of triggers (e.g. several quick task
 * edits each kicking a sync) into at most one in-flight + one queued run,
 * which avoids overlapping passes racing each other while still guaranteeing
 * the latest state is covered.
 *
 * Errors are swallowed: the intended use (best-effort background sync) treats
 * failures as no-ops, and swallowing keeps the in-flight state from getting
 * stuck after a rejection. The returned promise resolves when the run that
 * covers the caller's request (including any trailing run) has settled.
 */
export function createCoalescedRunner(
  task: () => Promise<unknown>
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let queued = false;

  const cycle = (): Promise<void> => {
    // Invoke synchronously (so an idle call starts work immediately), but guard
    // against a synchronous throw by funneling everything through a promise.
    let started: Promise<unknown>;
    try {
      started = Promise.resolve(task());
    } catch (err) {
      started = Promise.reject(err);
    }

    const run = started
      .then(
        () => undefined,
        () => undefined
      )
      .then(() => {
        inFlight = null;
        if (queued) {
          queued = false;
          return cycle();
        }
        return undefined;
      });
    inFlight = run;
    return run;
  };

  return () => {
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    return cycle();
  };
}
