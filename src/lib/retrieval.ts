/**
 * Retrieval over episodes.
 *
 * Three signals, blended:
 *   lexical  — SQLite FTS5/BM25 over the formatted text and the raw ASR.
 *              Catches exact names, jargon and acronyms that embeddings blur.
 *   vector   — cosine over chunk embeddings. Catches paraphrase.
 *   structural — time window, app, recipient. These come from the request itself
 *              ("around 5pm yesterday in Slack") and act as filters, not scores.
 *
 * The blended score is what the refusal threshold is applied to, so retrieval
 * quality and honesty are the same knob.
 */
import { sql, inArray } from 'drizzle-orm';
import { db, schema, sqlite, ensureFts } from '../db/client';
import { embedBatch, cosine, unpackVector } from './llm';
import { isStubMode, stubEmbed } from './stub';

export type StructuralFilter = {
  app?: string | null;
  recipient?: string | null;
  /** epoch ms inclusive */
  after?: number | null;
  before?: number | null;
  /** the instant the person actually named ("around 5pm"), used to rank ties by
   *  proximity rather than recency — "around 5" should not return the 6:50 message first */
  centre?: number | null;
};

export type RetrievedDictation = {
  id: string;
  spokenAt: number;
  app: string;
  recipient: string | null;
  windowTitle: string | null;
  formattedText: string;
  rawAsr: string;
  styleUsed: string | null;
  lexicalScore: number;
  vectorScore: number;
  score: number;
};

export type RetrievalResult = {
  hits: RetrievedDictation[];
  /** everything considered, for the inspection path */
  considered: number;
  latencyMs: number;
  usedVectors: boolean;
  topScore: number;
};

/** FTS5 needs its own quoting; user speech is full of apostrophes and hyphens. */
function toFtsQuery(q: string): string {
  const terms = (q.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [])
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .slice(0, 24)
    .map((t) => `"${t.replace(/"/g, '')}"`);
  if (terms.length === 0) return '';
  return terms.join(' OR ');
}

const STOPWORDS = new Set([
  'the','and','for','was','were','that','this','with','what','when','where','which','did','does',
  'you','your','our','their','from','have','has','had','about','into','out','are','can','will',
  'would','should','could','say','said','tell','told','get','got','any','all','how','why','who',
  'kivi','hey','please','find','show','give',
]);

function lexicalSearch(query: string, limit: number): Map<string, number> {
  ensureFts();
  const ftsQuery = toFtsQuery(query);
  const out = new Map<string, number>();
  if (!ftsQuery) return out;
  try {
    const rows = sqlite
      .prepare(
        `SELECT d.id AS id, bm25(dictations_fts, 6.0, 2.0, 1.0, 1.0, 0.5) AS rank
         FROM dictations_fts
         JOIN dictations d ON d.rowid = dictations_fts.rowid
         WHERE dictations_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(ftsQuery, limit) as { id: string; rank: number }[];
    // bm25 returns negative numbers, better = more negative. Map to 0..1.
    if (rows.length) {
      const best = Math.min(...rows.map((r) => r.rank));
      for (const r of rows) {
        const norm = best === 0 ? 0 : Math.max(0, Math.min(1, r.rank / best));
        out.set(r.id, norm);
      }
    }
  } catch {
    // A malformed MATCH must never take down a request; lexical simply contributes nothing.
  }
  return out;
}

async function vectorSearch(
  query: string,
  candidateIds: string[] | null,
  limit: number
): Promise<{ scores: Map<string, number>; ok: boolean }> {
  const scores = new Map<string, number>();
  let qv: Float32Array;
  try {
    if (isStubMode()) qv = stubEmbed([query]).vectors[0];
    else qv = (await embedBatch([query], 'RETRIEVAL_QUERY')).vectors[0];
  } catch {
    return { scores, ok: false };
  }
  if (!qv) return { scores, ok: false };

  const chunks = candidateIds?.length
    ? db
        .select()
        .from(schema.dictationChunks)
        .where(inArray(schema.dictationChunks.dictationId, candidateIds))
        .all()
    : db.select().from(schema.dictationChunks).all();

  for (const c of chunks) {
    if (!c.embedding) continue;
    const s = cosine(qv, unpackVector(c.embedding));
    const prev = scores.get(c.dictationId) ?? -1;
    if (s > prev) scores.set(c.dictationId, s);
  }
  // keep the strongest
  const trimmed = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit * 3);
  return { scores: new Map(trimmed), ok: true };
}

export async function retrieveDictations(
  query: string,
  filter: StructuralFilter = {},
  limit = 8
): Promise<RetrievalResult> {
  const started = Date.now();

  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.app) {
    conds.push('lower(app) = lower(?)');
    params.push(filter.app);
  }
  if (filter.recipient) {
    conds.push('lower(coalesce(recipient, "")) LIKE lower(?)');
    params.push(`%${filter.recipient}%`);
  }
  if (filter.after) {
    conds.push('spoken_at >= ?');
    params.push(filter.after);
  }
  if (filter.before) {
    conds.push('spoken_at <= ?');
    params.push(filter.before);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const allowed = sqlite
    .prepare(`SELECT id FROM dictations ${where}`)
    .all(...(params as any[])) as { id: string }[];
  const allowedIds = new Set(allowed.map((r) => r.id));

  const lex = lexicalSearch(query, limit * 6);
  const { scores: vec, ok: usedVectors } = await vectorSearch(
    query,
    allowedIds.size && allowedIds.size < 2000 ? [...allowedIds] : null,
    limit
  );

  const explicitFilters = [filter.app, filter.recipient, filter.after ?? filter.before].filter(Boolean).length;
  /**
   * A person who says "around 5pm yesterday in Slack" has given an ADDRESS, not a
   * description. When that address resolves to a handful of dictations, the address
   * itself is the grounding — text similarity is the wrong thing to be confident about.
   * So a narrow explicit filter raises the floor; a broad one does not.
   */
  const narrow = explicitFilters > 0 && allowedIds.size > 0 && allowedIds.size <= 12;
  /**
   * A stated time window is itself grounding, even when it is a whole day. "What was the
   * last thing I said in Slack yesterday" resolves to maybe forty dictations — too many to
   * call narrow, but the person has still told us exactly where to look, and refusing
   * there is a worse failure than answering from a wide-but-correct set.
   */
  const hasTimeWindow = Boolean(filter.after || filter.before);

  const ids = new Set<string>([...lex.keys(), ...vec.keys()].filter((x) => allowedIds.has(x)));

  // A purely structural request ("anything in Slack yesterday") has no lexical or
  // vector signal at all. Fall back to the filter itself, most recent first.
  if (explicitFilters > 0 && (ids.size === 0 || narrow)) {
    for (const x of [...allowedIds].slice(0, Math.max(limit * 3, 12))) ids.add(x);
  }
  if (ids.size === 0) {
    return { hits: [], considered: allowedIds.size, latencyMs: Date.now() - started, usedVectors, topScore: 0 };
  }

  const rows = db
    .select()
    .from(schema.dictations)
    .where(inArray(schema.dictations.id, [...ids]))
    .all();

  const hits: RetrievedDictation[] = rows
    .map((r) => {
      const lexicalScore = lex.get(r.id) ?? 0;
      const vectorScore = vec.get(r.id) ?? 0;
      // Lexical is weighted a little higher: in dictation, the exact name matters.
      const blended = usedVectors ? 0.55 * lexicalScore + 0.45 * vectorScore : lexicalScore;
      // Structural floor, justified above. It is a floor, never a bonus on top, so a
      // strong text match in a wide search still outranks a weak one in a narrow one.
      const floor = narrow ? 0.62 : hasTimeWindow ? 0.5 : explicitFilters > 0 ? 0.4 : 0;
      return {
        id: r.id,
        spokenAt: r.spokenAt,
        app: r.app,
        recipient: r.recipient,
        windowTitle: r.windowTitle,
        formattedText: r.formattedText,
        rawAsr: r.rawAsr,
        styleUsed: r.styleUsed,
        lexicalScore,
        vectorScore,
        score: Math.max(blended, floor),
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (filter.centre) return Math.abs(a.spokenAt - filter.centre) - Math.abs(b.spokenAt - filter.centre);
      return b.spokenAt - a.spokenAt;
    })
    .slice(0, limit);

  return {
    hits,
    considered: allowedIds.size,
    latencyMs: Date.now() - started,
    usedVectors,
    topScore: hits[0]?.score ?? 0,
  };
}

/** Entity lookup used by the lookup_entity tool. Active facts only, with provenance. */
export function lookupEntity(name: string) {
  const key = name.toLowerCase().trim();
  const rows = db.select().from(schema.entities).all();
  const match = rows.find((r) => {
    if (r.canonicalName.toLowerCase() === key) return true;
    const aliases: string[] = JSON.parse(r.aliases || '[]');
    if (aliases.some((a) => a.toLowerCase() === key)) return true;
    return r.canonicalName.toLowerCase().includes(key) || key.includes(r.canonicalName.toLowerCase());
  });
  if (!match) return null;
  const facts = db
    .select()
    .from(schema.entityFacts)
    .where(sql`${schema.entityFacts.entityId} = ${match.id}`)
    .all();
  const mentions = db
    .select()
    .from(schema.entityMentions)
    .where(sql`${schema.entityMentions.entityId} = ${match.id}`)
    .all();
  return { entity: match, facts, mentions };
}

export function activePreferences(app?: string | null) {
  const rows = db.select().from(schema.preferences).all();
  return rows.filter(
    (p) =>
      p.status === 'active' &&
      (p.scopeType === 'global' || !app || (p.scopeValue ?? '').toLowerCase() === app.toLowerCase())
  );
}
