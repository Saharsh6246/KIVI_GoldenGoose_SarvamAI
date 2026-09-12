/**
 * Corpus ingestion — the documented import path.
 *
 *   npx tsx scripts/ingest.ts --file corpus/corpus.jsonl
 *   npx tsx scripts/ingest.ts --file their-corpus.jsonl --map raw=asr_text,formatted=llm_text,at=created_at
 *
 * Accepts JSONL or a JSON array. Field names are resolved by alias so another team's
 * export usually needs no mapping at all; --map covers the rest.
 *
 * Stages, in order:
 *   1  persist the dictation verbatim              (the source of truth)
 *   2  chunk + embed                               (the retrieval index)
 *   3  gate                                        (cheap refusal, logged)
 *   4  extract                                     (model call, batched)
 *   5  consolidate                                 (promotion by repetition, provenance)
 *
 * Every stage that declines to learn something writes an ignored_records row, so the
 * question "what did it deliberately ignore?" has a table to answer it.
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isNull, sql } from 'drizzle-orm';
import { db, schema, dbBytes, reindexFts, DB_PATH } from '../src/db/client';
import { rateLimitSettings } from '../src/lib/ratelimit';
import { id } from '../src/lib/ids';
import { embedBatch, packVector, MODELS } from '../src/lib/llm';
import { isStubMode, stubEmbed } from '../src/lib/stub';
import { extractBatch, gate, type DictationForExtraction } from '../src/lib/memory/extract';
import { consolidate, emptyStats, recordIgnored } from '../src/lib/memory/consolidate';

/* ------------------------------------------------------------------- cli args */
const argv = process.argv.slice(2);
function arg(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return fallback;
}
const file = arg('file', 'corpus/corpus.jsonl')!;
const label = arg('label', 'corpus ingest')!;
const limit = Number(arg('limit', '0'));
const batchSize = Number(arg('batch', process.env.KIVI_EXTRACT_BATCH ?? '5'));
const skipExtraction = argv.includes('--no-extract');
const reprocess = argv.includes('--reprocess');
const mapArg = arg('map', '')!;

const overrides: Record<string, string> = {};
for (const pair of mapArg.split(',').filter(Boolean)) {
  const [k, v] = pair.split('=');
  if (k && v) overrides[k.trim()] = v.trim();
}

/* --------------------------------------------------------------- field aliases */
const ALIASES: Record<string, string[]> = {
  id: ['id', 'record_id', 'dictation_id', 'uuid'],
  raw: ['raw_asr', 'raw', 'asr', 'asr_text', 'transcript', 'raw_transcript', 'speech'],
  formatted: ['formatted_text', 'formatted', 'text', 'llm_output', 'llm_text', 'output', 'final_text'],
  at: ['spoken_at', 'timestamp', 'created_at', 'ts', 'time', 'started_at', 'date'],
  app: ['app', 'application', 'app_name', 'source_app', 'target_app', 'context_app'],
  window: ['window_title', 'window', 'title', 'context', 'channel', 'thread'],
  recipient: ['recipient', 'to', 'addressee', 'contact'],
  style: ['style', 'persona', 'style_used', 'profile'],
  lang: ['lang', 'language', 'locale'],
  duration: ['duration_ms', 'duration', 'length_ms'],
};

function field(rec: any, key: keyof typeof ALIASES): any {
  const forced = overrides[key];
  if (forced && rec[forced] !== undefined) return rec[forced];
  for (const a of ALIASES[key]) if (rec[a] !== undefined && rec[a] !== null) return rec[a];
  return undefined;
}

function parseTs(v: any): number {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const p = Date.parse(String(v));
  return Number.isFinite(p) ? p : Date.now();
}

/* ------------------------------------------------------------------- load file */
if (!existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}
const text = readFileSync(file, 'utf8').trim();
let raw: any[];
if (text.startsWith('[')) raw = JSON.parse(text);
else raw = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
if (limit > 0) raw = raw.slice(0, limit);

console.log(`ingest      ${file}  (${raw.length} records)`);
console.log(`database    ${DB_PATH}`);
console.log(`models      extraction=${MODELS.extraction} embedding=${MODELS.embedding}${isStubMode() ? '  [OFFLINE STUB]' : ''}`);
const rl = rateLimitSettings();
console.log(`rate limit  ${rl.rpm > 0 ? `${rl.rpm} requests/min (one at a time, ${rl.minIntervalMs}ms apart)` : 'disabled'} — set KIVI_RPM to change`);

const runId = id('run');
const bytesBefore = dbBytes();
const t0 = Date.now();
db.insert(schema.ingestRuns)
  .values({ id: runId, startedAt: t0, label, sourceFile: file, recordsSeen: raw.length })
  .run();

/* ------------------------------------------------------- stage 1: persist rows */
const toProcess: DictationForExtraction[] = [];
let inserted = 0;
let duplicates = 0;

db.transaction(() => {
  for (const rec of raw) {
    const rawAsr = String(field(rec, 'raw') ?? '');
    const formatted = String(field(rec, 'formatted') ?? rawAsr);
    if (!formatted.trim()) continue;

    // Stable id: use theirs when present, otherwise hash the content so re-running
    // an import does not duplicate the corpus.
    const given = field(rec, 'id');
    const dictationId = (() => {
      if (given != null) {
        const clean = String(given).replace(/[^a-zA-Z0-9_]/g, '');
        if (/^d_[a-z0-9]{4,}$/i.test(clean)) return clean.toLowerCase();
        if (clean) return `d_${createHash('sha1').update(clean).digest('hex').slice(0, 10)}`;
      }
      return `d_${createHash('sha1').update(formatted + String(field(rec, 'at') ?? '')).digest('hex').slice(0, 10)}`;
    })();

    const existing = db.select().from(schema.dictations).where(eq(schema.dictations.id, dictationId)).get();
    if (existing) {
      duplicates++;
      continue;
    }

    const row = {
      id: dictationId,
      spokenAt: parseTs(field(rec, 'at')),
      app: String(field(rec, 'app') ?? 'Unknown'),
      windowTitle: field(rec, 'window') != null ? String(field(rec, 'window')) : null,
      recipient: field(rec, 'recipient') != null ? String(field(rec, 'recipient')) : null,
      rawAsr,
      formattedText: formatted,
      styleUsed: field(rec, 'style') != null ? String(field(rec, 'style')) : null,
      durationMs: field(rec, 'duration') != null ? Number(field(rec, 'duration')) : null,
      lang: String(field(rec, 'lang') ?? 'en'),
      source: 'import' as const,
      corpusId: label,
      createdAt: Date.now(),
    };
    db.insert(schema.dictations).values(row).run();
    inserted++;
    toProcess.push({
      id: row.id,
      app: row.app,
      recipient: row.recipient,
      windowTitle: row.windowTitle,
      spokenAt: row.spokenAt,
      formattedText: row.formattedText,
      rawAsr: row.rawAsr,
    });
  }
});
console.log(`stage 1     ${inserted} dictations stored${duplicates ? `, ${duplicates} already present` : ''}`);

/* --------------------------------------------------- stage 2: chunk + embed */
/** Dictations are short. One chunk per dictation unless it is long, then ~2 sentences
 *  of overlap so a fact split across a paragraph break is still retrievable. */
function chunk(t: string): string[] {
  if (t.length <= 900) return [t];
  const sentences = t.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + ' ' + s).length > 700 && cur) {
      out.push(cur.trim());
      cur = out.length ? cur.split(/(?<=[.!?])\s+/).slice(-1)[0] + ' ' : '';
    }
    cur += s + ' ';
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Create chunks for any dictation that has none (this run's, or an earlier partial run's).
const needChunks = db.all<{ id: string; formatted_text: string }>(sql`
  SELECT d.id, d.formatted_text FROM dictations d
  LEFT JOIN dictation_chunks c ON c.dictation_id = d.id
  WHERE c.id IS NULL`);
if (needChunks.length) {
  db.transaction(() => {
    for (const d of needChunks) {
      chunk(d.formatted_text).forEach((text, ordinal) => {
        db.insert(schema.dictationChunks)
          .values({ id: id('ch'), dictationId: d.id, ordinal, text, embedding: null, tokens: Math.ceil(text.length / 4) })
          .run();
      });
    }
  });
}

let embedCost = 0;
let embedTokens = 0;
let embedFailed = 0;

// Backfill every chunk still missing a vector, whenever it was created. A run cut short
// by rate limits is resumed by simply running ingest again.
const unembedded = db.select().from(schema.dictationChunks).where(isNull(schema.dictationChunks.embedding)).all();
if (unembedded.length) {
  const B = 64;
  for (let i = 0; i < unembedded.length; i += B) {
    const slice = unembedded.slice(i, i + B);
    let vectors: Float32Array[] = [];
    try {
      const res = isStubMode()
        ? stubEmbed(slice.map((s) => s.text))
        : await embedBatch(slice.map((s) => s.text), 'RETRIEVAL_DOCUMENT');
      vectors = res.vectors;
      embedCost += res.usage.costUsd;
      embedTokens += res.usage.tokensIn;
    } catch (e: any) {
      embedFailed += slice.length;
      console.warn(`\n  embedding batch failed after retries (${e?.message?.slice(0, 80)}). Re-run ingest to backfill.`);
    }
    if (vectors.length) {
      db.transaction(() => {
        slice.forEach((c, j) => {
          if (!vectors[j]) return;
          db.update(schema.dictationChunks)
            .set({ embedding: packVector(vectors[j]) })
            .where(eq(schema.dictationChunks.id, c.id))
            .run();
        });
      });
    }
    process.stdout.write(`\rstage 2     embedding ${Math.min(i + B, unembedded.length)}/${unembedded.length}`);
  }
  console.log(`\rstage 2     ${unembedded.length - embedFailed}/${unembedded.length} chunks embedded${embedFailed ? `, ${embedFailed} still missing` : ''}${' '.repeat(14)}`);
} else {
  console.log('stage 2     all chunks already embedded');
}

/* --------------------------------------------------- stage 3+4+5: learn */
const stats = emptyStats();
let extractTokensIn = 0;
let extractTokensOut = 0;
let extractCost = 0;
let gatedOut = 0;

if (reprocess) {
  // Memory is a derived view over dictations. Recomputing it has to start from empty,
  // otherwise a second pass appends to the first and the counts stop meaning anything.
  db.delete(schema.entityFacts).run();
  db.delete(schema.entityMentions).run();
  db.delete(schema.entities).run();
  db.delete(schema.preferenceEvidence).run();
  db.delete(schema.preferences).run();
  db.delete(schema.ignoredRecords).run();
  db.delete(schema.memoryEvents).run();
  db.update(schema.dictations).set({ processedAt: null }).run();
  console.log('stage 3     --reprocess: derived memory cleared, every dictation marked unlearned');
  console.log('            (dictations themselves are untouched — they are the source of truth)');
}

/** Everything stored but never learned from — this run's inserts plus anything a
 *  previous run lost to rate limits. This is what makes ingestion resumable. */
const pending: DictationForExtraction[] = db
  .select()
  .from(schema.dictations)
  .where(isNull(schema.dictations.processedAt))
  .all()
  .map((r) => ({
    id: r.id,
    app: r.app,
    recipient: r.recipient,
    windowTitle: r.windowTitle,
    spokenAt: r.spokenAt,
    formattedText: r.formattedText,
    rawAsr: r.rawAsr,
  }));

let extractFailed = 0;

if (!skipExtraction && pending.length) {
  if (pending.length !== inserted)
    console.log(`stage 3     ${pending.length} dictations pending (${inserted} new, ${pending.length - inserted} left over from an earlier run)`);

  const passed: DictationForExtraction[] = [];
  for (const d of pending) {
    const g = gate(d);
    if (!g.pass) {
      recordIgnored(d.id, g.reason!, d.formattedText.slice(0, 120), 'gate');
      db.update(schema.dictations).set({ processedAt: Date.now() }).where(eq(schema.dictations.id, d.id)).run();
      gatedOut++;
      stats.ignored++;
    } else passed.push(d);
  }
  console.log(`stage 3     ${passed.length} passed the gate, ${gatedOut} carried nothing durable`);

  for (let i = 0; i < passed.length; i += batchSize) {
    const batch = passed.slice(i, i + batchSize);
    try {
      const { extractions, usage } = await extractBatch(batch);
      extractTokensIn += usage.tokensIn;
      extractTokensOut += usage.tokensOut;
      extractCost += usage.costUsd;
      const byId = new Map(batch.map((b) => [b.id, b]));
      db.transaction(() => {
        for (const ex of extractions) {
          const d = byId.get(ex.dictationId);
          if (d) consolidate(ex, d, stats);
        }
        // Only mark processed once consolidation has committed.
        for (const b of batch)
          db.update(schema.dictations).set({ processedAt: Date.now() }).where(eq(schema.dictations.id, b.id)).run();
      });
    } catch (e: any) {
      extractFailed += batch.length;
      console.warn(`\n  extraction batch failed after retries: ${e?.message?.slice(0, 120)}`);
      console.warn('  these dictations stay unlearned; re-run ingest to pick them up.');
    }
    process.stdout.write(
      `\rstage 4/5   ${Math.min(i + batchSize, passed.length)}/${passed.length}  entities=${stats.entitiesCreated} promoted=${stats.entitiesPromoted} facts=${stats.factsCreated}${extractFailed ? ` unlearned=${extractFailed}` : ''}`
    );
  }
  console.log('');
} else if (!skipExtraction) {
  console.log('stage 3-5   nothing pending — every dictation has been learned from');
}

reindexFts();

/* ------------------------------------------------------------------- report */
const wallMs = Date.now() - t0;
const bytesAfter = dbBytes();
const totalCost = embedCost + extractCost;

db.update(schema.ingestRuns)
  .set({
    finishedAt: Date.now(),
    recordsIngested: inserted,
    entitiesCreated: stats.entitiesCreated,
    entitiesPromoted: stats.entitiesPromoted,
    preferencesProposed: stats.preferencesProposed,
    recordsIgnored: stats.ignored,
    tokensIn: extractTokensIn + embedTokens,
    tokensOut: extractTokensOut,
    costUsd: totalCost,
    dbBytesBefore: bytesBefore,
    dbBytesAfter: bytesAfter,
    wallMs,
  })
  .where(eq(schema.ingestRuns.id, runId))
  .run();

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
console.log('');
console.log('─'.repeat(62));
console.log(`records ingested      ${inserted}`);
console.log(`entities created      ${stats.entitiesCreated}  (promoted to fact: ${stats.entitiesPromoted})`);
console.log(`facts recorded        ${stats.factsCreated}`);
console.log(`preferences proposed  ${stats.preferencesProposed}`);
console.log(`deliberately ignored  ${stats.ignored}`);
console.log(`database growth       ${kb(bytesBefore)} -> ${kb(bytesAfter)}  (+${kb(bytesAfter - bytesBefore)})`);
console.log(`wall time             ${(wallMs / 1000).toFixed(1)}s`);
console.log(`model cost            $${totalCost.toFixed(4)}  (${extractTokensIn + embedTokens} in / ${extractTokensOut} out)`);
console.log(`run id                ${runId}`);
const stillPending = db.get<{ n: number }>(sql`SELECT count(*) AS n FROM dictations WHERE processed_at IS NULL`)!.n;
const stillUnembedded = db.get<{ n: number }>(sql`SELECT count(*) AS n FROM dictation_chunks WHERE embedding IS NULL`)!.n;
console.log('─'.repeat(62));
if (stillPending > 0 || stillUnembedded > 0) {
  console.log('');
  console.log(`INCOMPLETE: ${stillPending} dictation(s) not yet learned from, ${stillUnembedded} chunk(s) without a vector.`);
  console.log('Run the same command again to resume — it picks up exactly what is missing.');
  console.log('If rate limits are the cause, lower the request budget first, e.g.  KIVI_RPM=6');
} else {
  console.log('COMPLETE: every dictation has been embedded and learned from.');
}
