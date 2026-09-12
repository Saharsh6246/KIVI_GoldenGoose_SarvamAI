/**
 * Reproducible evaluation.
 *
 *   npm run eval
 *
 * Runs the whole product — retrieval, tools, model, guards — over the ingested corpus
 * and checks it against the ground truth planted in corpus/ground_truth.json.
 *
 * Two kinds of case:
 *   ask      — put a question to Hey Kivi and assert on the answer, its citations,
 *              and whether it refused.
 *   inspect  — assert directly on the memory state, which is where the claims that
 *              have no natural question live: what was deliberately not learned,
 *              whether provenance is intact, whether a preference was adopted silently.
 *
 * Failures are printed, not hidden, and every case links to the interaction id so the
 * exact retrieval, trace and reasoning can be re-read in the app afterwards.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { db, schema, dbBytes } from '../src/db/client';
import { id } from '../src/lib/ids';
import { ask } from '../src/lib/heykivi/agent';
import { isStubMode } from '../src/lib/stub';
import { formatLocal } from '../src/lib/tz';
import { rateLimitSettings } from '../src/lib/ratelimit';

type Case = any;
const suite = JSON.parse(readFileSync('eval/cases.json', 'utf8'));
const NOW = Date.parse(suite.pinnedNow);

/** tag -> dictation id, read from the corpus so cases survive regeneration */
const tagToId = new Map<string, string>();
try {
  for (const line of readFileSync('corpus/corpus.jsonl', 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.tag) tagToId.set(r.tag, String(r.id).toLowerCase());
  }
} catch {
  console.warn('corpus/corpus.jsonl not found — tag-based assertions will be skipped.');
}

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null;
const resume = process.argv.includes('--resume');

let alreadyPassed = new Set<string>();
if (resume) {
  try {
    const prev = JSON.parse(readFileSync('eval/results/latest.json', 'utf8'));
    alreadyPassed = new Set(prev.results.filter((r: any) => r.passed).map((r: any) => r.caseId));
  } catch {
    console.warn('--resume: no previous report found, running everything.');
  }
}

const cases: Case[] = suite.cases
  .filter((c: Case) => !only || c.id === only || c.category === only)
  .filter((c: Case) => !alreadyPassed.has(c.id));

const runId = id('eval');
const startedAt = Date.now();
const bytesAtStart = dbBytes();
db.insert(schema.evalRuns)
  .values({ id: runId, startedAt, suite: suite.suite, totalCases: cases.length })
  .run();

console.log(`\nkivi evaluation · ${suite.suite}`);
console.log(`run ${runId} · ${cases.length} cases · clock pinned to ${formatLocal(NOW)}`);
if (isStubMode()) {
  console.log('\n!! KIVI_OFFLINE_STUB=1 — the model is stubbed. This run is a plumbing check,');
  console.log('!! not a valid evaluation of the product. Results are marked invalid.\n');
}
console.log('─'.repeat(78));

type Row = {
  caseId: string;
  category: string;
  passed: boolean;
  verdict: string;
  detail: string;
  latencyMs: number;
  costUsd: number;
  interactionId?: string;
  question?: string;
};
const rows: Row[] = [];
let totalCost = 0;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

/* --------------------------------------------------------------- assertions */

function checkAsk(c: Case, r: Awaited<ReturnType<typeof ask>>): { ok: boolean; why: string[] } {
  const why: string[] = [];
  const a = norm(r.answer);

  if (c.expect_refusal === true && !r.refused) why.push(`expected a refusal, got an answer (top score ${r.topScore.toFixed(2)})`);
  if (c.expect_refusal === false && r.refused) why.push('expected an answer, got a refusal');

  if (c.expect_cites_tag) {
    for (const tag of c.expect_cites_tag) {
      const want = tagToId.get(tag);
      if (!want) continue;
      if (!r.citations.includes(want)) why.push(`did not cite ${tag} (${want}); cited [${r.citations.join(', ') || 'nothing'}]`);
    }
  }
  if (c.expect_min_citations && r.citations.length < c.expect_min_citations)
    why.push(`expected ${c.expect_min_citations}+ citations, got ${r.citations.length}`);

  if (c.expect_contains_all)
    for (const s of c.expect_contains_all) if (!a.includes(norm(s))) why.push(`answer missing "${s}"`);

  if (c.expect_contains_any && !c.expect_contains_any.some((s: string) => a.includes(norm(s))))
    why.push(`answer contained none of [${c.expect_contains_any.join(', ')}]`);

  if (c.expect_not_contains)
    for (const s of c.expect_not_contains) if (a.includes(norm(s))) why.push(`answer must not contain "${s}"`);

  return { ok: why.length === 0, why };
}

function checkInspect(c: Case): { ok: boolean; why: string[] } {
  const why: string[] = [];
  const A = c.assert ?? {};

  if (A.entity_active) {
    const e = db.select().from(schema.entities).all().find((x) => x.canonicalName.toLowerCase() === String(A.entity_active).toLowerCase());
    if (!e) why.push(`entity "${A.entity_active}" was never created`);
    else {
      if (e.status !== 'active') why.push(`entity "${A.entity_active}" is ${e.status}, not active`);
      if (A.min_distinct_dictations && e.distinctDictations < A.min_distinct_dictations)
        why.push(`entity "${A.entity_active}" has ${e.distinctDictations} distinct dictations, expected ${A.min_distinct_dictations}+`);
    }
  }

  if (A.all_active_entities_have_min_distinct) {
    const bad = db.select().from(schema.entities).all()
      .filter((e) => e.status === 'active' && e.distinctDictations < A.all_active_entities_have_min_distinct);
    if (bad.length) why.push(`${bad.length} active entities below the promotion rule: ${bad.slice(0, 5).map((b) => b.canonicalName).join(', ')}`);
  }

  if (A.no_orphan_provenance) {
    const orphans = db.all<{ n: number }>(sql`
      SELECT count(*) AS n FROM entity_mentions m
      LEFT JOIN dictations d ON d.id = m.dictation_id WHERE d.id IS NULL`);
    const n = (orphans as any)[0]?.n ?? 0;
    if (n > 0) why.push(`${n} entity mentions point at dictations that do not exist`);
  }

  if (A.no_entity_matching) {
    const all = db.select().from(schema.entities).all();
    for (const term of A.no_entity_matching) {
      const hit = all.find((e) => e.canonicalName.toLowerCase().includes(String(term).toLowerCase()));
      if (hit) why.push(`learned an entity it should not have: "${hit.canonicalName}" (matched "${term}")`);
    }
  }

  if (A.no_fact_matching) {
    const all = db.select().from(schema.entityFacts).all();
    for (const term of A.no_fact_matching) {
      const hit = all.find((f) => f.claim.toLowerCase().includes(String(term).toLowerCase()));
      if (hit) why.push(`stored a fact it should not have: "${hit.claim}"`);
    }
  }

  if (A.dictation_still_findable_tag) {
    const want = tagToId.get(A.dictation_still_findable_tag);
    if (want) {
      const row = db.select().from(schema.dictations).where(eq(schema.dictations.id, want)).get();
      if (!row) why.push(`the dictation tagged ${A.dictation_still_findable_tag} is gone — sensitive material must stay searchable, only unlearned`);
    }
  }

  if (A.ignored_records_have_reasons) {
    const all = db.select().from(schema.ignoredRecords).all();
    if (A.min_ignored && all.length < A.min_ignored) why.push(`only ${all.length} ignore records, expected ${A.min_ignored}+`);
    const blank = all.filter((r) => !r.reason);
    if (blank.length) why.push(`${blank.length} ignore records carry no reason`);
  }

  if (A.preference_matching) {
    const prefs = db.select().from(schema.preferences).all();
    const hit = prefs.find((p) => A.preference_matching.some((t: string) => p.statement.toLowerCase().includes(t.toLowerCase())));
    if (!hit) why.push(`no preference matching [${A.preference_matching.join(', ')}] was learned`);
    else if (A.min_evidence && hit.evidenceCount < A.min_evidence)
      why.push(`preference "${hit.statement}" has ${hit.evidenceCount} pieces of evidence, expected ${A.min_evidence}+`);
  }

  if (A.no_preference_active_without_decision) {
    const bad = db.select().from(schema.preferences).all().filter((p) => p.status === 'active' && !p.decidedAt);
    if (bad.length) why.push(`${bad.length} preferences are active without the person accepting them`);
  }

  if (A.all_citations_resolve) {
    const inter = db.select().from(schema.interactions).where(eq(schema.interactions.evalRunId, runId)).all();
    let bad = 0;
    for (const i of inter) {
      const cited = [...(i.answer ?? '').matchAll(/\[([a-z]_[a-z0-9]{4,})\]/g)].map((m) => m[1]);
      for (const c of cited) {
        const exists = db.select().from(schema.dictations).where(eq(schema.dictations.id, c)).get();
        if (!exists) bad++;
      }
    }
    if (bad > 0) why.push(`${bad} citations across this run point at nothing`);
  }

  return { ok: why.length === 0, why };
}

/* ------------------------------------------------------------------- run it */

const latencies: number[] = [];
const askCases = cases.filter((c) => c.type === 'ask');
const inspectCases = cases.filter((c) => c.type !== 'ask' && c.type !== 'inspect_all_interactions');
const finalCases = cases.filter((c) => c.type === 'inspect_all_interactions');

let quotaExhausted = false;

for (const c of askCases) {
  if (quotaExhausted) break;
  const t = Date.now();
  let r: Awaited<ReturnType<typeof ask>> | null = null;
  let err: string | null = null;
  try {
    r = await ask({ query: c.question, app: c.app ?? null, now: NOW, evalRunId: runId });
  } catch (e: any) {
    err = e?.message ?? String(e);
    // A 429 that survived every retry means the key's quota is gone. Continuing would
    // spend several minutes of backoff per case to record the same failure each time.
    if (/\b429\b/.test(err ?? '')) quotaExhausted = true;
  }
  const latency = Date.now() - t;
  latencies.push(latency);

  const res = r ? checkAsk(c, r) : { ok: false, why: [`threw: ${err}`] };
  totalCost += r?.costUsd ?? 0;
  rows.push({
    caseId: c.id,
    category: c.category,
    passed: res.ok,
    verdict: res.ok ? 'pass' : 'fail',
    detail: res.why.join(' | ') || (r?.refused ? `refused: ${r.refusalReason}` : 'ok'),
    latencyMs: latency,
    costUsd: r?.costUsd ?? 0,
    interactionId: r?.interactionId,
    question: c.question,
  });
  console.log(
    `${res.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(6)} ${c.category.padEnd(16)} ${String(latency).padStart(5)}ms  ${c.question?.slice(0, 46) ?? ''}`
  );
  if (!res.ok) for (const w of res.why) console.log(`      ↳ ${w}`);
  if (r && !res.ok) {
    console.log(
      `      ↳ top score ${r.topScore.toFixed(2)} (threshold ${process.env.KIVI_REFUSAL_THRESHOLD ?? 0.34}) · retrieved ${r.trace.filter((t) => t.kind === 'dictation').length} · tools ${r.toolCalls.map((t) => t.name).join(',') || 'none'}`
    );
    if (r.refusalReason) console.log(`      ↳ guard: ${r.refusalReason}`);
    console.log(`      ↳ shown:  ${r.answer.slice(0, 150).replace(/\n/g, ' ')}`);
    if (r.rawAnswer && r.rawAnswer !== r.answer)
      console.log(`      ↳ model said: ${r.rawAnswer.slice(0, 220).replace(/\n/g, ' ')}`);
    console.log(`      ↳ inspect: ${r.interactionId}`);
  }
}

if (quotaExhausted) {
  console.log('');
  console.log('STOPPED: the model quota is exhausted, so the remaining ask-cases were not run.');
  console.log('The state assertions below do not need the model and still ran.');
  console.log('When quota resets, continue with:  npm run eval -- --resume');
  console.log('');
}

for (const c of [...inspectCases, ...finalCases]) {
  const t = Date.now();
  const res = checkInspect(c);
  rows.push({
    caseId: c.id,
    category: c.category,
    passed: res.ok,
    verdict: res.ok ? 'pass' : 'fail',
    detail: res.why.join(' | ') || 'ok',
    latencyMs: Date.now() - t,
    costUsd: 0,
  });
  console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(6)} ${c.category.padEnd(16)}         ${c.expectation.slice(0, 50)}`);
  if (!res.ok) for (const w of res.why) console.log(`      ↳ ${w}`);
}

/* -------------------------------------------------------------------- report */

/**
 * Latency, reported honestly.
 *
 * End-to-end time on a free-tier key is dominated by OUR OWN rate-limit gate, which
 * deliberately spaces calls to avoid losing batches to 429s. Quoting that as the
 * product's latency would be misleading in both directions, so the report separates:
 *   retrieval  — the memory system's own work, which is what the architecture is judged on
 *   end-to-end — what a person actually waits, gate included, stated as such
 */
const runInteractions = db.select().from(schema.interactions).where(eq(schema.interactions.evalRunId, runId)).all();
const retrievalLatencies = runInteractions.map((i) => i.retrievalMs ?? 0).sort((a, b) => a - b);
const rpct = (p: number) => retrievalLatencies[Math.min(retrievalLatencies.length - 1, Math.floor((retrievalLatencies.length - 1) * p))] ?? 0;
const gate = rateLimitSettings();

let carriedForConsole: Row[] = [];
if (resume && alreadyPassed.size) {
  try {
    const prev = JSON.parse(readFileSync('eval/results/latest.json', 'utf8'));
    carriedForConsole = prev.results.filter((r: any) => alreadyPassed.has(r.caseId));
  } catch {
    /* nothing to carry */
  }
}
const combined = [...carriedForConsole, ...rows];
const passed = combined.filter((r) => r.passed).length;
const failed = combined.length - passed;
latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * p))] ?? 0;

const counts = db.get<any>(sql`SELECT
  (SELECT count(*) FROM dictations) AS dictations,
  (SELECT count(*) FROM entities WHERE status='active') AS active_entities,
  (SELECT count(*) FROM entities WHERE status='candidate') AS candidate_entities,
  (SELECT count(*) FROM entity_facts) AS facts,
  (SELECT count(*) FROM preferences) AS preferences,
  (SELECT count(*) FROM ignored_records) AS ignored,
  (SELECT count(*) FROM memory_events) AS events`);

const byCategory: Record<string, { pass: number; total: number }> = {};
for (const r of combined) {
  byCategory[r.category] ??= { pass: 0, total: 0 };
  byCategory[r.category].total++;
  if (r.passed) byCategory[r.category].pass++;
}

db.update(schema.evalRuns)
  .set({ finishedAt: Date.now(), passed, failed, costUsd: totalCost, notes: isStubMode() ? 'INVALID: offline stub mode' : null })
  .where(eq(schema.evalRuns.id, runId))
  .run();

for (const r of rows) {
  db.insert(schema.evalResults)
    .values({
      id: id('er'),
      runId,
      caseId: r.caseId,
      category: r.category,
      question: r.question ?? '(state assertion)',
      expectation: cases.find((c) => c.id === r.caseId)?.expectation ?? '',
      interactionId: r.interactionId ?? null,
      passed: r.passed,
      verdict: r.verdict,
      detail: r.detail,
      latencyMs: r.latencyMs,
      costUsd: r.costUsd,
    })
    .run();
}

console.log('─'.repeat(78));
console.log(`result            ${passed}/${combined.length} passed${failed ? `, ${failed} failed` : ''}${resume && carriedForConsole.length ? `  (${carriedForConsole.length} carried from the previous run, ${rows.length} re-run)` : ''}`);
for (const [cat, v] of Object.entries(byCategory))
  console.log(`  ${cat.padEnd(18)} ${v.pass}/${v.total}`);
console.log(`retrieval         p50 ${rpct(0.5)}ms · p95 ${rpct(0.95)}ms   (includes one query-embedding API call, which the gate also throttles)`);
console.log(`end-to-end        p50 ${pct(0.5)}ms · p95 ${pct(0.95)}ms · max ${latencies[latencies.length - 1] ?? 0}ms`);
console.log(`                  ${gate.rpm > 0 ? `includes deliberate throttle waits of up to ${gate.minIntervalMs}ms per model call (KIVI_RPM=${gate.rpm}); set KIVI_RPM=0 on a paid key` : 'rate-limit gate disabled'}`);
console.log(`memory state      ${counts.dictations} dictations · ${counts.active_entities} active entities (${counts.candidate_entities} candidates) · ${counts.facts} facts · ${counts.preferences} preferences`);
console.log(`deliberately ignored  ${counts.ignored} · audit events ${counts.events}`);
console.log(`database          ${(bytesAtStart / 1024).toFixed(0)} KB, ${(dbBytes() / 1024).toFixed(0)} KB after`);
console.log(`model cost        $${totalCost.toFixed(4)} for this run`);
if (isStubMode()) console.log(`validity          INVALID — offline stub mode`);
console.log('─'.repeat(78));

mkdirSync('eval/results', { recursive: true });

const allRows = combined;
const allPassed = passed;

const report = {
  runId,
  suite: suite.suite,
  startedAt: new Date(startedAt).toISOString(),
  finishedAt: new Date().toISOString(),
  valid: !isStubMode(),
  pinnedNow: suite.pinnedNow,
  summary: { passed: allPassed, failed: allRows.length - allPassed, total: allRows.length, byCategory },
  partial: quotaExhausted || undefined,
  latencyMs: {
    retrieval: { p50: rpct(0.5), p95: rpct(0.95) },
    endToEnd: { p50: pct(0.5), p95: pct(0.95), max: latencies[latencies.length - 1] ?? 0 },
    note: gate.rpm > 0 ? `End-to-end includes a deliberate ${gate.minIntervalMs}ms gap between model calls (KIVI_RPM=${gate.rpm}) to stay inside free-tier quota.` : 'Rate-limit gate disabled.',
  },
  rateLimit: gate,
  memoryState: counts,
  costUsd: totalCost,
  dbBytes: { before: bytesAtStart, after: dbBytes() },
  results: allRows,
};
writeFileSync('eval/results/latest.json', JSON.stringify(report, null, 2) + '\n');
writeFileSync(`eval/results/${runId}.json`, JSON.stringify(report, null, 2) + '\n');

const md = [
  `# Evaluation — ${suite.suite}`,
  ``,
  `Run \`${runId}\` · ${new Date(startedAt).toISOString()} · clock pinned to ${suite.pinnedNow}`,
  isStubMode() ? `\n> **INVALID RUN** — offline stub mode was on. This checks plumbing, not the product.\n` : '',
  ``,
  `**${passed}/${rows.length} passed.** · $${totalCost.toFixed(4)}`,
  ``,
  `Retrieval p50 **${rpct(0.5)}ms**, p95 **${rpct(0.95)}ms** — this includes one query-embedding API call,`,
  `which the rate-limit gate throttles like any other. Lexical + vector search over the stored`,
  `corpus is single-digit milliseconds; the rest is the network round trip and the gate.`,
  `End-to-end p50 ${pct(0.5)}ms, p95 ${pct(0.95)}ms —`,
  gate.rpm > 0
    ? `which includes a deliberate ${gate.minIntervalMs}ms gap between model calls (\`KIVI_RPM=${gate.rpm}\`) to stay inside free-tier quota. Set \`KIVI_RPM=0\` on a paid key.`
    : `with the rate-limit gate disabled.`,
  ``,
  `| category | passed |`,
  `| --- | --- |`,
  ...Object.entries(byCategory).map(([c, v]) => `| ${c} | ${v.pass}/${v.total} |`),
  ``,
  `## Memory state after ingestion`,
  ``,
  `| | |`,
  `| --- | --- |`,
  ...Object.entries(counts).map(([k, v]) => `| ${k.replace(/_/g, ' ')} | ${v} |`),
  ``,
  `## Cases`,
  ``,
  `| id | category | result | latency | detail |`,
  `| --- | --- | --- | --- | --- |`,
  ...rows.map(
    (r) => `| ${r.caseId} | ${r.category} | ${r.passed ? 'pass' : '**fail**'} | ${r.latencyMs}ms | ${r.detail.replace(/\|/g, '/').slice(0, 160)} |`
  ),
  ``,
  `Every \`ask\` case above has an interaction id. Open it in the app under **Trace** to see`,
  `the retrieval candidates, their scores, which memories were used, and why.`,
  ``,
].join('\n');
writeFileSync('eval/results/latest.md', md);

console.log(`\nwrote eval/results/latest.json and eval/results/latest.md`);
process.exit(failed > 0 ? 1 : 0);
