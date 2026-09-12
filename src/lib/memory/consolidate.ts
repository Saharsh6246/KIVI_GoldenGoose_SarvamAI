/**
 * Stage 3: turn per-dictation extractions into the durable memory graph.
 *
 * This is where the position's evidence standard is enforced:
 *   - a candidate becomes a fact only after independent repetition
 *   - every row keeps the dictations that produced it
 *   - every decision, including every refusal, writes a memory_event
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client';
import { id } from '../ids';
import {
  PROMOTION_MIN_DISTINCT_DICTATIONS,
  PREFERENCE_MIN_EVIDENCE,
  IGNORE_REASONS,
  type IgnoreReason,
} from './policy';
import type { Extraction, DictationForExtraction } from './extract';

export type ConsolidationStats = {
  entitiesCreated: number;
  entitiesReinforced: number;
  entitiesPromoted: number;
  factsCreated: number;
  factsSuperseded: number;
  preferencesProposed: number;
  preferencesReinforced: number;
  ignored: number;
};

export function emptyStats(): ConsolidationStats {
  return {
    entitiesCreated: 0,
    entitiesReinforced: 0,
    entitiesPromoted: 0,
    factsCreated: 0,
    factsSuperseded: 0,
    preferencesProposed: 0,
    preferencesReinforced: 0,
    ignored: 0,
  };
}

/** Normalises a spoken surface form for matching: case, punctuation, plurals. */
export function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(the|a|an)\s+/g, '')
    .trim();
}

function logEvent(e: {
  action: string;
  targetType: string;
  targetId: string;
  targetLabel?: string | null;
  sourceDictationId?: string | null;
  reason: string;
  model?: string | null;
}) {
  db.insert(schema.memoryEvents)
    .values({
      id: id('ev'),
      at: Date.now(),
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      targetLabel: e.targetLabel ?? null,
      sourceDictationId: e.sourceDictationId ?? null,
      reason: e.reason,
      model: e.model ?? null,
    })
    .run();
}

/**
 * The extractor is asked for a reason from a fixed set and does not always comply —
 * one run produced ten spellings of "an instruction about code". Free text here would
 * make the ignore log unaggregatable, and the whole point of that log is that it can be
 * counted and audited. So reasons are mapped back onto the taxonomy, with the model's
 * original wording preserved in `detail`.
 */
const REASON_ALIASES: [RegExp, IgnoreReason][] = [
  [/health|medical|therapy|physio|illness|diagnos/i, 'sensitive_category'],
  [/salary|compensation|financial|money|legal|immigration|religio|politic/i, 'sensitive_category'],
  [/mood|emotion|personality|trait|infer|about the (user|person|speaker)|speaker is/i, 'inference_about_person'],
  [/third[_ -]?party|someone else|colleague'?s? (private|personal|family)/i, 'third_party_private'],
  [/code|system|technical|engineering|project instruction|work[_ ]?instruction|not[_ ]?a[_ ]?preference|task/i, 'no_durable_content'],
  [/transient|temporar|momentary|time[- ]sensitive|ephemeral/i, 'transient'],
  [/duplicate|already known|redundant/i, 'duplicate'],
  [/confidence|unsure|uncertain|ambiguous|unclear/i, 'low_confidence'],
  [/single|once|one mention/i, 'single_mention'],
  [/no durable|nothing durable|not durable|trivial|no content/i, 'no_durable_content'],
];

function normaliseReason(reason: string): { key: IgnoreReason; original: string | null } {
  if (reason in IGNORE_REASONS) return { key: reason as IgnoreReason, original: null };
  for (const [re, key] of REASON_ALIASES) if (re.test(reason)) return { key, original: reason };
  return { key: 'low_confidence', original: reason };
}

export function recordIgnored(
  dictationId: string,
  reason: IgnoreReason | string,
  candidate: string,
  stage: string,
  detail?: string
) {
  const { key, original } = normaliseReason(String(reason));
  db.insert(schema.ignoredRecords)
    .values({
      id: id('ig'),
      dictationId,
      reason: key,
      detail:
        detail ??
        [original ? `Extractor said: "${original}".` : null, (IGNORE_REASONS as Record<string, string>)[key]]
          .filter(Boolean)
          .join(' ') ??
        null,
      candidate,
      stage,
      createdAt: Date.now(),
    })
    .run();
}

function findEntity(name: string): typeof schema.entities.$inferSelect | undefined {
  const key = normaliseName(name);
  const rows = db.select().from(schema.entities).all();
  for (const r of rows) {
    if (normaliseName(r.canonicalName) === key) return r;
    const aliases: string[] = JSON.parse(r.aliases || '[]');
    if (aliases.some((a) => normaliseName(a) === key)) return r;
  }
  // Acronym <-> expansion: "MRD" vs "Meridian" is left to explicit aliases on purpose.
  return undefined;
}

export function consolidate(
  extraction: Extraction,
  dictation: DictationForExtraction,
  stats: ConsolidationStats
): void {
  const now = Date.now();

  /* ---- refusals reported by the extractor ---- */
  for (const ig of extraction.ignored ?? []) {
    recordIgnored(dictation.id, ig.reason, ig.candidate, 'extraction', ig.detail);
    stats.ignored++;
  }

  /* ---- entities ---- */
  for (const e of extraction.entities ?? []) {
    if ((e.confidence ?? 0) < 0.35) {
      recordIgnored(dictation.id, 'low_confidence', e.name, 'consolidation');
      stats.ignored++;
      continue;
    }
    // Evidence must actually be present in what was said.
    const supported =
      !e.evidence ||
      dictation.formattedText.toLowerCase().includes(e.name.toLowerCase()) ||
      dictation.rawAsr.toLowerCase().includes(e.name.toLowerCase());
    if (!supported) {
      recordIgnored(
        dictation.id,
        'low_confidence',
        e.name,
        'consolidation',
        'Name does not appear in the dictation it was extracted from.'
      );
      stats.ignored++;
      continue;
    }

    let row = findEntity(e.name);
    if (!row) {
      const entityId = id('e');
      db.insert(schema.entities)
        .values({
          id: entityId,
          canonicalName: e.name,
          kind: e.kind,
          aliases: JSON.stringify(e.aliases ?? []),
          summary: null,
          status: 'candidate',
          mentionCount: 0,
          distinctDictations: 0,
          confidence: e.confidence ?? 0.5,
          firstSeen: dictation.spokenAt,
          lastSeen: dictation.spokenAt,
          reason: `First heard in a dictation to ${dictation.app} on ${new Date(
            dictation.spokenAt
          ).toDateString()}. Held as a candidate until another dictation mentions it.`,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      row = db.select().from(schema.entities).where(eq(schema.entities.id, entityId)).get()!;
      stats.entitiesCreated++;
      logEvent({
        action: 'created',
        targetType: 'entity',
        targetId: entityId,
        targetLabel: e.name,
        sourceDictationId: dictation.id,
        reason: 'New name heard. Candidate only — one mention is not evidence.',
      });
      // NOTE: a first mention is NOT logged as a refusal. It is held as a candidate,
      // which is a different thing and is visible as such in the Memory surface.
    } else {
      stats.entitiesReinforced++;
    }

    // Provenance row, one per (entity, dictation, surface form).
    const already = db
      .select()
      .from(schema.entityMentions)
      .where(
        and(
          eq(schema.entityMentions.entityId, row.id),
          eq(schema.entityMentions.dictationId, dictation.id)
        )
      )
      .get();

    if (!already) {
      db.insert(schema.entityMentions)
        .values({
          id: id('m'),
          entityId: row.id,
          dictationId: dictation.id,
          surfaceForm: e.name,
          snippet: (e.evidence || dictation.formattedText).slice(0, 320),
          spokenAt: dictation.spokenAt,
        })
        .run();
    }

    const counts = db
      .select({
        mentions: sql<number>`count(*)`,
        distinct: sql<number>`count(distinct ${schema.entityMentions.dictationId})`,
      })
      .from(schema.entityMentions)
      .where(eq(schema.entityMentions.entityId, row.id))
      .get()!;

    const aliases = new Set<string>(JSON.parse(row.aliases || '[]'));
    for (const a of e.aliases ?? []) aliases.add(a);
    if (normaliseName(e.name) !== normaliseName(row.canonicalName)) aliases.add(e.name);

    const shouldPromote =
      row.status === 'candidate' && counts.distinct >= PROMOTION_MIN_DISTINCT_DICTATIONS;

    db.update(schema.entities)
      .set({
        mentionCount: counts.mentions,
        distinctDictations: counts.distinct,
        aliases: JSON.stringify([...aliases]),
        lastSeen: Math.max(row.lastSeen ?? 0, dictation.spokenAt),
        firstSeen: Math.min(row.firstSeen ?? dictation.spokenAt, dictation.spokenAt),
        status: shouldPromote ? 'active' : row.status,
        confidence: Math.min(0.99, 0.4 + 0.12 * counts.distinct),
        reason: shouldPromote
          ? `Mentioned in ${counts.distinct} separate dictations, so Kivi treats it as part of your working world.`
          : row.reason,
        updatedAt: now,
      })
      .where(eq(schema.entities.id, row.id))
      .run();

    if (shouldPromote) {
      stats.entitiesPromoted++;
      logEvent({
        action: 'promoted',
        targetType: 'entity',
        targetId: row.id,
        targetLabel: row.canonicalName,
        sourceDictationId: dictation.id,
        reason: `Confirmed by a ${counts.distinct}${counts.distinct === 2 ? 'nd' : 'th'} independent dictation.`,
      });
    } else {
      logEvent({
        action: 'reinforced',
        targetType: 'entity',
        targetId: row.id,
        targetLabel: row.canonicalName,
        sourceDictationId: dictation.id,
        reason: `Mentioned again (${counts.distinct} distinct dictations so far).`,
      });
    }

    /* ---- facts about the entity ---- */
    for (const claim of e.facts ?? []) {
      if (!claim || claim.length < 4) continue;
      const dup = db
        .select()
        .from(schema.entityFacts)
        .where(and(eq(schema.entityFacts.entityId, row.id), eq(schema.entityFacts.claim, claim)))
        .get();
      if (dup) {
        recordIgnored(dictation.id, 'duplicate', claim, 'consolidation');
        stats.ignored++;
        continue;
      }
      const factId = id('f');
      db.insert(schema.entityFacts)
        .values({
          id: factId,
          entityId: row.id,
          dictationId: dictation.id,
          claim,
          state: 'current',
          spokenAt: dictation.spokenAt,
          createdAt: now,
        })
        .run();
      stats.factsCreated++;
      logEvent({
        action: 'created',
        targetType: 'entity_fact',
        targetId: factId,
        targetLabel: claim,
        sourceDictationId: dictation.id,
        reason: 'Stated directly in this dictation.',
      });
    }
  }

  /* ---- preferences ---- */
  for (const p of extraction.preferences ?? []) {
    if ((p.confidence ?? 0) < 0.4 || !p.statement) {
      recordIgnored(dictation.id, 'low_confidence', p.statement ?? '(blank)', 'consolidation');
      stats.ignored++;
      continue;
    }
    // A preference is about how Kivi WRITES. Instructions about code, systems or what a
    // colleague should do are work, and slipped through the extractor often enough to be
    // worth catching here as well.
    if (!looksLikeWritingPreference(p.statement)) {
      recordIgnored(
        dictation.id,
        'no_durable_content',
        p.statement,
        'consolidation',
        'An instruction about the work, not about how Kivi should write. Not a writing preference.'
      );
      stats.ignored++;
      continue;
    }

    // Scope hygiene: the extractor sometimes files an application under a recipient scope.
    let scopeType = p.scopeType;
    let scopeValue = p.scopeType === 'global' ? null : (p.scopeValue ?? dictation.app);
    if (scopeType === 'recipient' && scopeValue && KNOWN_APPS.has(scopeValue.toLowerCase())) {
      scopeType = 'app';
    }
    if (scopeType === 'app' && !scopeValue) scopeValue = dictation.app;

    // Deduplicate across scopes, not only within one. The same instruction said twice
    // must reinforce one preference, or it never reaches the evidence bar.
    const existing = db
      .select()
      .from(schema.preferences)
      .all()
      .find(
        (r) =>
          similar(r.statement, p.statement) &&
          (r.scopeType === scopeType
            ? (r.scopeValue ?? null) === (scopeValue ?? null)
            : r.scopeType === 'global' || scopeType === 'global')
      );

    let prefId: string;
    if (existing) {
      prefId = existing.id;
      stats.preferencesReinforced++;
    } else {
      prefId = id('p');
      db.insert(schema.preferences)
        .values({
          id: prefId,
          scopeType,
          scopeValue,
          statement: p.statement,
          status: 'proposed',
          evidenceCount: 0,
          confidence: p.confidence ?? 0.5,
          reason: 'Heard you ask for this once. Kivi waits for a pattern before offering it.',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      logEvent({
        action: 'created',
        targetType: 'preference',
        targetId: prefId,
        targetLabel: p.statement,
        sourceDictationId: dictation.id,
        reason: 'You asked for this explicitly in a dictation.',
      });
    }

    db.insert(schema.preferenceEvidence)
      .values({
        id: id('pe'),
        preferenceId: prefId,
        dictationId: dictation.id,
        kind: p.kind,
        snippet: p.evidence.slice(0, 300),
        spokenAt: dictation.spokenAt,
      })
      .run();

    const count = db
      .select({ n: sql<number>`count(distinct ${schema.preferenceEvidence.dictationId})` })
      .from(schema.preferenceEvidence)
      .where(eq(schema.preferenceEvidence.preferenceId, prefId))
      .get()!.n;

    const ready = count >= PREFERENCE_MIN_EVIDENCE;
    const current = db.select().from(schema.preferences).where(eq(schema.preferences.id, prefId)).get()!;

    db.update(schema.preferences)
      .set({
        evidenceCount: count,
        confidence: Math.min(0.95, 0.35 + 0.15 * count),
        reason: ready
          ? `You have asked for this in ${count} separate dictations. Kivi will offer it — it never applies a preference you have not accepted.`
          : `Seen ${count} of ${PREFERENCE_MIN_EVIDENCE} times needed before Kivi offers it.`,
        updatedAt: now,
      })
      .where(eq(schema.preferences.id, prefId))
      .run();

    if (ready && current.status === 'proposed') stats.preferencesProposed++;
  }
}

const KNOWN_APPS = new Set([
  'slack','mail','email','linear','cursor','notion','notes','messages','jira','gmail','outlook','vscode','figma',
]);

/**
 * Does this instruction concern how Kivi writes, rather than what the work should be?
 *
 * A allowlist of writing vocabulary, plus a blocklist of engineering vocabulary. Crude,
 * and deliberately biased toward refusing: a wrongly adopted preference silently changes
 * the person's words, which is exactly the failure the product position forbids.
 */
function looksLikeWritingPreference(statement: string): boolean {
  const t = statement.toLowerCase();
  const writing =
    /\b(shorter|longer|concise|brief|terse|verbose|wordy|preamble|greeting|salutation|sign[- ]?off|signature|tone|formal|casual|polite|blunt|bullet|paragraph|sentence|line|word|phrase|spell|spelt|spelled|capitali[sz]|punctuat|emoji|write|written|writing|word it|phrase it|say it|call it|refer to|address (them|me|her|him)|start (my|the|an|a) (email|message|reply)|open (my|the) (email|message))\b/;
  const engineering =
    /\b(retry|retries|attempt|endpoint|backoff|migration|backfill|schema|column|deploy|test|flaky|cache|latency|p99|throughput|ticket|issue|sprint|rollback|dashboard|queue|api|service|repo|commit|branch|inbox|send the|route (it|questions))\b/;
  if (engineering.test(t) && !writing.test(t)) return false;
  return writing.test(t);
}

/** Loose statement matching so "make it shorter" and "keep it short" collapse. */
function similar(a: string, b: string): boolean {
  const norm = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
  const A = norm(a);
  const B = norm(b);
  if (A.size === 0 || B.size === 0) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.6;
}
