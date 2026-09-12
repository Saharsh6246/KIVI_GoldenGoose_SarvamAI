/**
 * Turning spoken time into a filter.
 *
 * "around 5pm yesterday" is the single most load-bearing phrase in the example use
 * case, so it is parsed deterministically rather than left to the model: a model that
 * guesses a date range produces a confidently wrong answer, which is the exact failure
 * the product position forbids.
 *
 * `now` is injected so that evaluation is reproducible against a fixed corpus.
 */
import { startOfLocalDay, localTime, localDayOfWeek } from '../tz';

export type TimeWindow = { after: number | null; before: number | null; label: string | null; centre?: number | null };

const DAY = 86_400_000;
const startOfDay = startOfLocalDay;

export function parseTimeExpression(text: string, now: number = Date.now()): TimeWindow {
  const t = text.toLowerCase();
  const today0 = startOfDay(now);

  let dayStart: number | null = null;
  let label: string | null = null;

  if (/\byesterday\b/.test(t)) {
    dayStart = today0 - DAY;
    label = 'yesterday';
  } else if (/\btoday\b|\bthis morning\b|\bthis afternoon\b|\bthis evening\b/.test(t)) {
    dayStart = today0;
    label = 'today';
  } else if (/\bday before yesterday\b/.test(t)) {
    dayStart = today0 - 2 * DAY;
    label = 'the day before yesterday';
  }

  const lastWeekday = t.match(
    /\b(?:last|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/
  );
  if (!dayStart && lastWeekday) {
    const names = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const want = names.indexOf(lastWeekday[1]);
    let d = today0;
    for (let i = 1; i <= 7; i++) {
      if (localDayOfWeek(d - i * DAY) === want) {
        d = d - i * DAY;
        break;
      }
    }
    dayStart = d;
    label = `last ${lastWeekday[1]}`;
  }

  if (!dayStart) {
    if (/\blast week\b/.test(t)) return { after: today0 - 7 * DAY, before: now, label: 'last week' };
    if (/\bthis week\b/.test(t)) return { after: today0 - 7 * DAY, before: now, label: 'this week' };
    if (/\blast month\b/.test(t)) return { after: today0 - 30 * DAY, before: now, label: 'last month' };
    if (/\brecently\b|\blately\b/.test(t)) return { after: now - 14 * DAY, before: now, label: 'recently' };
  }

  // Clock time: "5 pm", "5:30pm", "17:00", "around 9 in the morning"
  const clock = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? t.match(/\b(\d{1,2}):(\d{2})\b/);
  let hour: number | null = null;
  let minute = 0;
  if (clock) {
    hour = parseInt(clock[1], 10);
    minute = clock[2] ? parseInt(clock[2], 10) : 0;
    const mer = clock[3];
    if (mer === 'pm' && hour < 12) hour += 12;
    if (mer === 'am' && hour === 12) hour = 0;
    if (!mer && /morning/.test(t) && hour === 12) hour = 0;
    if (!mer && /(evening|night)/.test(t) && hour < 12) hour += 12;
  } else if (/\bmorning\b/.test(t)) hour = 9;
  else if (/\bafternoon\b/.test(t)) hour = 14;
  else if (/\bevening\b/.test(t)) hour = 19;

  if (dayStart !== null && hour !== null) {
    const centre = localTime(dayStart, hour, minute);
    // "around" is generous on purpose: a person's sense of when they said something
    // is vague, and a too-tight window turns a findable dictation into a refusal.
    const slack = /\baround\b|\babout\b|\bish\b|\bsometime\b/.test(t) ? 2 * 3_600_000 : 90 * 60_000;
    return {
      after: centre - slack,
      before: centre + slack,
      centre,
      label: `${label ?? 'that day'} around ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    };
  }
  if (dayStart !== null) return { after: dayStart, before: dayStart + DAY - 1, label };
  return { after: null, before: null, label: null };
}

/** Widen a window when nothing was found, up to whole-day, then give up.
 *  Returns null when there is nothing left to widen. */
export function widen(w: TimeWindow): TimeWindow | null {
  if (w.after === null || w.before === null) return null;
  const span = w.before - w.after;
  if (span >= DAY) return null;
  const centre = (w.after + w.before) / 2;
  const next = Math.min(DAY, span * 3);
  return {
    after: Math.round(centre - next / 2),
    before: Math.round(centre + next / 2),
    centre: w.centre ?? centre,
    label: w.label ? `${w.label} (widened)` : null,
  };
}
