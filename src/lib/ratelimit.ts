/**
 * A global gate in front of every Gemini call.
 *
 * The free tier is quota-limited per minute, and ingesting 500 dictations fires far
 * more requests than that allows. Without a gate the run does not fail cleanly — it
 * loses scattered batches to 429s and produces a memory that is quietly incomplete,
 * which is the worst outcome for a product whose claim is that it does not guess.
 *
 * So: one request at a time, spaced to a configurable requests-per-minute budget.
 * Slower, and complete. KIVI_RPM=0 disables the gate for paid keys.
 */
const RPM = Number(process.env.KIVI_RPM ?? 10);
const MIN_INTERVAL_MS = RPM > 0 ? Math.ceil(60_000 / RPM) : 0;

let chain: Promise<unknown> = Promise.resolve();
let lastStart = 0;

export function rateLimited<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    if (MIN_INTERVAL_MS > 0) {
      const wait = lastStart + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    lastStart = Date.now();
    return fn();
  });
  // Keep the chain alive even when a call rejects, so one failure cannot wedge the queue.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run as Promise<T>;
}

/** Gemini returns a RetryInfo with a precise delay. Honour it rather than guessing. */
export function retryDelayFromBody(body: string): number | null {
  try {
    const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
    if (m) return Math.ceil(parseFloat(m[1]) * 1000);
  } catch {
    /* fall through */
  }
  return null;
}

export function rateLimitSettings() {
  return { rpm: RPM, minIntervalMs: MIN_INTERVAL_MS };
}
