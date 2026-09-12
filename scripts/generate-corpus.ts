/**
 * Deterministic corpus generator.
 *
 * ~500 transcript-like records for one persona over eight weeks. No model is called:
 * the corpus is generated from templates with a seeded PRNG, which means
 *
 *   - it is byte-identical on every machine, so the evaluation is reproducible;
 *   - we know exactly which facts are planted where, so the evaluation can assert
 *     recall and refusal against a real ground truth rather than a guess.
 *
 * Each record carries raw ASR (disfluent, unpunctuated, with plausible mishearings)
 * and the LLM-formatted output Kivi would have typed, plus the metadata a real
 * dictation log carries: app, window, recipient, duration, language, style.
 *
 *   npm run corpus:generate
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { APPS, GROUND_TRUTH, PEOPLE, PROJECTS, REPOS, SLACK_CHANNELS, TOOLS, PERSONA } from './persona';
import { startOfLocalDay, localTime, localDayOfWeek } from '../src/lib/tz';

/* ----------------------------------------------------------------- seeded rng */
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = Number(process.env.KIVI_CORPUS_SEED ?? 20260912);
const rnd = mulberry32(SEED);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const chance = (p: number) => rnd() < p;
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

function rid(prefix: string, n = 6) {
  const A = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < n; i++) s += A[Math.floor(rnd() * A.length)];
  return `${prefix}_${s}`;
}

/* ------------------------------------------------------------------- calendar */
/** The corpus ends the day before CORPUS_NOW so that "yesterday" is well defined. */
export const CORPUS_NOW = Date.parse('2026-09-12T09:30:00+05:30');
const DAY = 86_400_000;
const WEEKS = 8;
/** Midnight (persona-local) of the first day of the corpus. */
const FIRST_DAY = startOfLocalDay(CORPUS_NOW - WEEKS * 7 * DAY);

function workdayTimestamp(dayOffset: number, hour: number, minute: number): number {
  return localTime(FIRST_DAY + dayOffset * DAY, hour, minute, int(0, 59));
}

/* --------------------------------------------------------------- ASR mangling */

const MISHEARINGS: Record<string, string[]> = {
  Meridian: ['meridien', 'meridian', 'merid ian', 'meridiann'],
  Tollgate: ['toll gate', 'tollgate', 'tol gate'],
  'Blue Ledger': ['blue ledger', 'blu ledger', 'blue ledgar'],
  Atlas: ['atlas', 'atlus'],
  Priya: ['priya', 'prea', 'priya'],
  Karthik: ['karthik', 'kartik', 'karthick'],
  Meera: ['meera', 'mira', 'meera'],
  Rohan: ['rohan', 'rohaan'],
  Sandra: ['sandra', 'sandra', 'sondra'],
  Tobias: ['tobias', 'tobius'],
  Datadog: ['data dog', 'datadog'],
  Temporal: ['temporal', 'tempural'],
  Postgres: ['postgres', 'post gres', 'postgress'],
  Snowflake: ['snowflake', 'snow flake'],
  Grafana: ['grafana', 'graphana'],
  RCA: ['r c a', 'rca'],
  SLO: ['s l o', 'slo'],
  API: ['a p i', 'api'],
};

const FILLERS = ['um', 'uh', 'so', 'like', 'you know', 'basically', 'right', 'I mean'];

/** Turn polished text back into something an ASR system would have emitted. */
function toRawAsr(formatted: string): string {
  let t = formatted;
  for (const [proper, variants] of Object.entries(MISHEARINGS)) {
    const re = new RegExp(`\\b${proper}\\b`, 'g');
    t = t.replace(re, () => pick(variants));
  }
  t = t
    .replace(/\n+/g, ' ')
    .replace(/[—–]/g, ' ')
    .replace(/[.,;:!?()"'`]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();

  const words = t.split(' ');
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (i > 0 && chance(0.055)) out.push(pick(FILLERS));
    // occasional stutter / restart, as real speech does
    if (chance(0.02) && words[i].length > 3) out.push(words[i].slice(0, 2));
    out.push(words[i]);
  }
  if (chance(0.25)) out.unshift(pick(['um', 'okay so', 'right so', 'uh']));
  return out.join(' ');
}

/* ------------------------------------------------------------------ templates */

type Draft = {
  app?: string;
  text: string;
  window?: string;
  recipient?: string | null;
  /** marks a record the evaluation refers to */
  tag?: string;
};

function person() {
  return pick(PEOPLE);
}
function project() {
  return pick(PROJECTS);
}

const SLACK_TEMPLATES: (() => Draft)[] = [
  () => {
    const p = person(), pr = project();
    return { text: `${p.short} — ${pr.name} staging is green again. The retry loop was the problem, not the queue.`, recipient: p.name };
  },
  () => {
    const pr = project();
    return { text: `Pushed the fix for ${pr.name}. Can someone give it a look before standup?` };
  },
  () => {
    const p = person();
    return { text: `${p.short} can you take the ${pick(REPOS)} review? I am heads down on ${project().name} until Thursday.`, recipient: p.name };
  },
  () => ({ text: `${pick(TOOLS)} is showing elevated p99 on ${pick(REPOS)}. Watching it for another twenty minutes before I page anyone.` }),
  () => ({ text: `Standup from me: ${project().name} yesterday, ${project().name} today, no blockers.` }),
  () => {
    const p = person();
    return { text: `Thanks ${p.short}, that unblocked me.`, recipient: p.name };
  },
  () => ({ text: `Moving the ${project().name} sync to Thursday, too many conflicts on Wednesday.` }),
  () => ({ text: `The ${pick(TOOLS)} dashboard for ${project().name} is wrong — it is counting retries as failures.` }),
  () => ({ text: `I am going to cut the scope on ${project().name} rather than slip. Two of the four flows can wait.` }),
  () => ({ text: `Anyone know why ${pick(REPOS)} builds are taking nine minutes now? It was three last month.` }),
];

const MAIL_TEMPLATES: (() => Draft)[] = [
  () => {
    const p = pick(PEOPLE.filter((x) => x.role.includes('client') || x.role.includes('partner')));
    return {
      text: `${p.short},\n\nSharing where we are on ${project().name}. The integration tests pass end to end and we are holding the last two edge cases for next week.\n\nHappy to walk through it on a call if that is easier.\n\nAnanya`,
      recipient: p.name,
      window: `Re: ${project().name} status`,
    };
  },
  () => {
    const p = person();
    return {
      text: `${p.short},\n\nFollowing up on the review comments. I have addressed all but the schema one, which I would like to talk through.\n\nAnanya`,
      recipient: p.name,
      window: 'Re: review comments',
    };
  },
  () => ({
    text: `Team,\n\nSummary of the incident: ${pick(REPOS)} rejected writes for eleven minutes after the ${pick(TOOLS)} upgrade. No data loss. Full RCA to follow.\n\nAnanya`,
    window: 'Incident summary',
    recipient: 'payments-eng@northwind.example',
  }),
];

const LINEAR_TEMPLATES: (() => Draft)[] = [
  () => ({ text: `${project().name}: retries are double counted in the reconciliation report. Fix the aggregation, add a test for the duplicate case.`, window: 'NW-' + int(200, 899) }),
  () => ({ text: `Split this ticket. The migration and the backfill are different risks and should ship separately.`, window: 'NW-' + int(200, 899) }),
  () => ({ text: `Blocked on ${person().short} confirming the schema. Parking this until Monday.`, window: 'NW-' + int(200, 899) }),
  () => ({ text: `Acceptance criteria: p99 under 250 milliseconds at 2x current traffic, no increase in error rate, dashboards updated.`, window: 'NW-' + int(200, 899) }),
];

const CURSOR_TEMPLATES: (() => Draft)[] = [
  () => ({ text: `Refactor the retry handler so backoff is configurable per endpoint. Keep the existing default of three attempts.`, window: pick(REPOS) + '/retry.ts' }),
  () => ({ text: `Add a migration that backfills the settlement_id column in batches of five thousand, resumable.`, window: pick(REPOS) + '/migrations' }),
  () => ({ text: `This test is flaky because it depends on wall clock time. Inject a clock instead.`, window: pick(REPOS) + '/tests' }),
  () => ({ text: `Write the commit message: fix double counting of retries in reconciliation aggregate.`, window: pick(REPOS) }),
];

const NOTION_TEMPLATES: (() => Draft)[] = [
  () => ({ text: `Design note for ${project().name}. Options considered: dual write, change data capture, and a scheduled reconcile. Going with change data capture because it does not need application changes in the legacy service.`, window: `${project().name} design` }),
  () => ({ text: `Weekly notes. Shipped the ${project().name} read path. Still carrying the backfill. Risk: the legacy service has no owner.`, window: 'Weekly notes' }),
];

const NOTES_TEMPLATES: (() => Draft)[] = [
  () => ({ text: `Remember to ask ${person().short} about the ${project().name} rollback plan.`, window: 'Scratch' }),
  () => ({ text: `Idea: cache the ${pick(TOOLS)} lookup per request, it is called four times in the same path.`, window: 'Scratch' }),
];

const MESSAGES_TEMPLATES: (() => Draft)[] = [
  () => ({ text: `Running about ten minutes late, start without me.`, recipient: person().name }),
  () => ({ text: `Picked up the thing, all good.`, recipient: person().name }),
];

const BY_APP: Record<string, (() => Draft)[]> = {
  Slack: SLACK_TEMPLATES,
  Mail: MAIL_TEMPLATES,
  Linear: LINEAR_TEMPLATES,
  Cursor: CURSOR_TEMPLATES,
  Notion: NOTION_TEMPLATES,
  Notes: NOTES_TEMPLATES,
  Messages: MESSAGES_TEMPLATES,
};

function weightedApp(): (typeof APPS)[number] {
  const total = APPS.reduce((n, a) => n + a.weight, 0);
  let r = rnd() * total;
  for (const a of APPS) {
    r -= a.weight;
    if (r <= 0) return a;
  }
  return APPS[0];
}

/* ------------------------------------------------------- planted ground truth */

type Planted = Draft & { app: string; dayOffset: number; hour: number; minute: number };

function plantedRecords(): Planted[] {
  const out: Planted[] = [];
  const D = WEEKS * 7;

  // --- Meridian launch date: stated twice as 14 Oct, then moved to 21 Oct ---
  out.push({ app: 'Slack', dayOffset: 12, hour: 11, minute: 20, window: '#meridian-launch', recipient: null, tag: 'meridian_launch_date',
    text: 'Locking the Meridian go live for the 14th of October. That gives us two weeks of buffer after the freeze.' });
  out.push({ app: 'Mail', dayOffset: 19, hour: 9, minute: 40, window: 'Meridian timeline', recipient: 'Sandra Lopez', tag: 'meridian_launch_date',
    text: 'Sandra,\n\nConfirming the Meridian go live date of 14 October. We will freeze changes the week before.\n\nAnanya' });
  out.push({ app: 'Slack', dayOffset: 41, hour: 16, minute: 5, window: '#meridian-launch', recipient: null, tag: 'meridian_launch_date',
    text: 'Update on Meridian: we are moving the go live from the 14th to the 21st of October. The backfill needs another week.' });

  // --- deploy command, four times in Cursor ---
  for (const [i, day] of [7, 21, 34, 49].entries()) {
    out.push({ app: 'Cursor', dayOffset: day, hour: 14 + (i % 3), minute: 12 + i * 7, window: 'northwind/ledger-svc/Makefile', recipient: null, tag: 'ledger_deploy_command',
      text: `Deploying ledger-svc to staging with make deploy-staging SVC equals ledger, then watching the Datadog dashboard for five minutes.` });
  }

  // --- Fernway contact ---
  out.push({ app: 'Mail', dayOffset: 9, hour: 10, minute: 15, window: 'Fernway integration', recipient: 'Sandra Lopez', tag: 'fernway_contact',
    text: 'Sandra,\n\nGood to meet you. You are our main contact at Fernway for the integration, so I will route questions to you.\n\nAnanya' });
  out.push({ app: 'Slack', dayOffset: 23, hour: 15, minute: 30, window: 'DM: Dev Menon', recipient: 'Dev Menon', tag: 'fernway_contact',
    text: 'Dev, Sandra Lopez is the Fernway contact. Send the scoping doc to her, not to the shared inbox.' });
  out.push({ app: 'Linear', dayOffset: 37, hour: 11, minute: 45, window: 'NW-512', recipient: null, tag: 'fernway_contact',
    text: 'Waiting on Sandra at Fernway for the sandbox credentials before this can move.' });

  // --- Tollgate ownership handover ---
  out.push({ app: 'Slack', dayOffset: 28, hour: 12, minute: 10, window: '#tollgate', recipient: null, tag: 'tollgate_owner',
    text: 'Handing Tollgate over to Karthik from today. He owns the rate limiter and the on call rotation for it now.' });
  out.push({ app: 'Linear', dayOffset: 33, hour: 10, minute: 5, window: 'NW-604', recipient: null, tag: 'tollgate_owner',
    text: 'Reassigning to Karthik, he owns Tollgate now.' });

  // --- incident + RCA deadline ---
  out.push({ app: 'Slack', dayOffset: 45, hour: 22, minute: 40, window: '#incidents', recipient: null, tag: 'rca_deadline',
    text: 'Ledger service rejected writes for eleven minutes after the Temporal upgrade. Mitigated by rolling back. No data loss.' });
  out.push({ app: 'Mail', dayOffset: 46, hour: 9, minute: 20, window: 'Incident follow up', recipient: 'Priya Raghavan', tag: 'rca_deadline',
    text: 'Priya,\n\nThe RCA for last night is due this Friday, the 18th of September. I will have a draft by Thursday lunchtime.\n\nAnanya' });

  // --- the "5pm yesterday in Slack" case for the headline demo ---
  out.push({ app: 'Slack', dayOffset: D - 1, hour: 17, minute: 4, window: '#meridian-launch', recipient: null, tag: 'demo_5pm',
    text: 'Quick status before I log off. Meridian read path is done and deployed to staging. The backfill is at about sixty percent and should finish overnight. Two open risks: the legacy service still has no named owner, and we have not tested the rollback under load. I want a decision on the owner before Monday.' });

  // --- preference signals ---
  for (const [i, day] of [14, 30, 44].entries())
    out.push({ app: 'Slack', dayOffset: day, hour: 13, minute: 20 + i, window: 'DM: Kivi', recipient: null, tag: 'pref_slack_short',
      text: 'Actually make that shorter. Keep my Slack messages to two lines, I do not need the preamble.' });
  for (const [i, day] of [11, 26, 47].entries())
    out.push({ app: 'Mail', dayOffset: day, hour: 9, minute: 5 + i, window: 'Draft', recipient: null, tag: 'pref_no_hope_well',
      text: "Rewrite that opening. Do not start my emails with Hope you're well, just get to the point." });
  for (const [i, day] of [16, 29, 50].entries())
    out.push({ app: 'Slack', dayOffset: day, hour: 15, minute: 10 + i, window: 'DM: Kivi', recipient: null, tag: 'pref_name_meridian',
      text: 'Always write Meridian in full, never MRD. Fix it everywhere.' });

  // --- sensitive material: searchable, never a stored fact about the person ---
  out.push({ app: 'Messages', dayOffset: 18, hour: 8, minute: 30, window: 'DM', recipient: 'Priya Raghavan', tag: 'sensitive_health',
    text: 'I have a physiotherapy appointment at four so I will drop off a bit early today.' });
  out.push({ app: 'Notes', dayOffset: 35, hour: 20, minute: 15, window: 'Scratch', recipient: null, tag: 'sensitive_money',
    text: 'Points for the compensation conversation: scope grew, I am running two services, and the band has not moved in eighteen months.' });
  out.push({ app: 'Messages', dayOffset: 40, hour: 19, minute: 50, window: 'DM', recipient: 'Dev Menon', tag: 'sensitive_third_party',
    text: 'Go easy on Rohan this week, he is dealing with something at home and asked me not to make it a thing.' });
  out.push({ app: 'Slack', dayOffset: 52, hour: 18, minute: 40, window: 'DM: Priya Raghavan', recipient: 'Priya Raghavan', tag: 'sensitive_mood',
    text: 'Honestly I am exhausted after this launch. Taking Friday off.' });

  return out;
}

/* --------------------------------------------------------------------- build */

type Record_ = {
  id: string;
  spoken_at: string;
  app: string;
  window_title: string | null;
  recipient: string | null;
  lang: string;
  duration_ms: number;
  style: string;
  raw_asr: string;
  formatted_text: string;
  source: 'import';
  tag?: string;
};

function makeRecord(app: string, style: string, ts: number, d: Draft): Record_ {
  const words = d.text.split(/\s+/).length;
  return {
    id: rid('d'),
    spoken_at: new Date(ts).toISOString(),
    app,
    window_title: d.window ?? (app === 'Slack' ? pick(SLACK_CHANNELS) : null),
    recipient: d.recipient ?? null,
    lang: 'en',
    // ~2.6 words/second of speech plus a beat at each end
    duration_ms: Math.round((words / 2.6) * 1000) + int(600, 2200),
    style,
    raw_asr: toRawAsr(d.text),
    formatted_text: d.text,
    source: 'import',
    ...(d.tag ? { tag: d.tag } : {}),
  };
}

function build(target = 500): Record_[] {
  const records: Record_[] = [];

  for (const p of plantedRecords()) {
    const style = APPS.find((a) => a.app === p.app)!.style;
    records.push(makeRecord(p.app, style, workdayTimestamp(p.dayOffset, p.hour, p.minute), p));
  }

  const D = WEEKS * 7;
  let guard = 0;
  while (records.length < target && guard++ < target * 20) {
    const dayOffset = int(0, D - 1);
    const dow = localDayOfWeek(FIRST_DAY + dayOffset * DAY);
    // Mostly weekdays, with the occasional weekend note.
    if ((dow === 0 || dow === 6) && !chance(0.12)) continue;
    const a = weightedApp();
    const draft = pick(BY_APP[a.app])();
    const hour = chance(0.08) ? int(19, 22) : int(9, 18);
    records.push(makeRecord(a.app, a.style, workdayTimestamp(dayOffset, hour, int(0, 59)), draft));
  }

  records.sort((x, y) => Date.parse(x.spoken_at) - Date.parse(y.spoken_at));
  return records;
}

const records = build(Number(process.env.KIVI_CORPUS_SIZE ?? 500));
mkdirSync('corpus', { recursive: true });
writeFileSync('corpus/corpus.jsonl', records.map((r) => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(
  'corpus/ground_truth.json',
  JSON.stringify(
    { persona: PERSONA, seed: SEED, corpusNow: new Date(CORPUS_NOW).toISOString(), count: records.length, ...GROUND_TRUTH },
    null,
    2
  ) + '\n'
);

const byApp: Record<string, number> = {};
for (const r of records) byApp[r.app] = (byApp[r.app] ?? 0) + 1;
console.log(`corpus/corpus.jsonl  ${records.length} records`);
console.log(`window               ${records[0].spoken_at.slice(0, 10)} .. ${records[records.length - 1].spoken_at.slice(0, 10)}`);
console.log(`apps                 ${Object.entries(byApp).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`planted              ${records.filter((r) => r.tag).length} tagged records`);
