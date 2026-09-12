/**
 * One fixed clock for the whole system.
 *
 * "around 5pm yesterday" only means something relative to the person's own timezone.
 * If the corpus is generated in one timezone and queried in another, every time-scoped
 * question quietly answers wrong — the worst kind of failure for a product whose whole
 * claim is that it does not guess.
 *
 * So the offset is explicit, configurable, and used by BOTH the corpus generator and
 * the query-time parser. Default is IST (+05:30), the persona's timezone.
 */
export const TZ_OFFSET_MIN = Number(process.env.KIVI_TZ_OFFSET_MINUTES ?? 330);
const MS = 60_000;

/** Midnight of the local day containing `ts`, as an epoch-ms instant. */
export function startOfLocalDay(ts: number): number {
  const shifted = ts + TZ_OFFSET_MIN * MS;
  const dayStart = Math.floor(shifted / 86_400_000) * 86_400_000;
  return dayStart - TZ_OFFSET_MIN * MS;
}

/** Epoch ms for a local wall-clock time. */
export function localTime(dayStart: number, hour: number, minute: number, second = 0): number {
  return dayStart + ((hour * 60 + minute) * 60 + second) * 1000;
}

/** Day of week (0=Sun) in the configured timezone. */
export function localDayOfWeek(ts: number): number {
  return new Date(ts + TZ_OFFSET_MIN * MS).getUTCDay();
}

/** Human-readable local time, for UI and traces. */
export function formatLocal(ts: number, withDate = true): string {
  const d = new Date(ts + TZ_OFFSET_MIN * MS);
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 16);
  return withDate ? `${date} ${time}` : time;
}

export function formatLocalDateLong(ts: number): string {
  const d = new Date(ts + TZ_OFFSET_MIN * MS);
  return d.toUTCString().slice(0, 16);
}
