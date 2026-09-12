/**
 * Kivi semantic memory — database schema.
 *
 * The shape of this schema IS the product position:
 *
 *   dictations                 the only source of truth. Nothing enters memory that
 *                              was not spoken into Kivi.
 *   dictation_chunks           retrieval index over those dictations.
 *   entities / preferences     DERIVED views over dictations. Every row carries the
 *                              episodes that produced it, and cascades away when they go.
 *   *_evidence tables          provenance. A memory that cannot point at an utterance
 *                              is not allowed to exist.
 *   ignored_records            what the system deliberately refused to learn, and why.
 *   memory_events              append-only audit of every create/update/reject/delete.
 *   interactions / traces      why memory did or did not affect a given answer.
 */
import { sqliteTable, text, integer, real, index, primaryKey } from 'drizzle-orm/sqlite-core';

/* ------------------------------------------------------------------ EPISODES */

export const dictations = sqliteTable(
  'dictations',
  {
    id: text('id').primaryKey(),
    /** epoch ms, when the person spoke */
    spokenAt: integer('spoken_at').notNull(),
    /** application the text was dictated into: "Slack", "Mail", "Cursor", ... */
    app: text('app').notNull(),
    /** window / thread / document title, as the OS reports it */
    windowTitle: text('window_title'),
    /** who it was addressed to, when the app exposes that */
    recipient: text('recipient'),
    /** verbatim ASR, disfluencies and all */
    rawAsr: text('raw_asr').notNull(),
    /** what Kivi actually typed, after Styles */
    formattedText: text('formatted_text').notNull(),
    /** the Style/persona in force for that app */
    styleUsed: text('style_used'),
    durationMs: integer('duration_ms'),
    lang: text('lang').default('en'),
    /** 'live' = spoken in this app, 'import' = loaded from a corpus */
    source: text('source').notNull().default('import'),
    corpusId: text('corpus_id'),
    createdAt: integer('created_at').notNull(),
    /** When extraction last completed for this dictation. NULL means it has been stored
     *  but never learned from — so a run interrupted by rate limits can be resumed
     *  rather than silently leaving holes in memory. */
    processedAt: integer('processed_at'),
  },
  (t) => ({
    byTime: index('dictations_spoken_at_idx').on(t.spokenAt),
    byApp: index('dictations_app_idx').on(t.app),
    byCorpus: index('dictations_corpus_idx').on(t.corpusId),
    byProcessed: index('dictations_processed_idx').on(t.processedAt),
  })
);

export const dictationChunks = sqliteTable(
  'dictation_chunks',
  {
    id: text('id').primaryKey(),
    dictationId: text('dictation_id')
      .notNull()
      .references(() => dictations.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    /** Float32Array serialised; null when embeddings are unavailable (lexical-only mode) */
    embedding: text('embedding'),
    tokens: integer('tokens'),
  },
  (t) => ({ byDictation: index('chunks_dictation_idx').on(t.dictationId) })
);

/* -------------------------------------------------------------------- FACTS */

export const entities = sqliteTable(
  'entities',
  {
    id: text('id').primaryKey(),
    canonicalName: text('canonical_name').notNull(),
    /** person | project | product | repo | acronym | tool | place | event */
    kind: text('kind').notNull(),
    /** JSON array of surface forms seen in speech */
    aliases: text('aliases').notNull().default('[]'),
    /** one sentence, itself grounded in the evidence rows */
    summary: text('summary'),
    /** 'candidate' until it survives repetition; then 'active'. 'rejected' is kept on purpose. */
    status: text('status').notNull().default('candidate'),
    mentionCount: integer('mention_count').notNull().default(0),
    /** number of DISTINCT dictations mentioning it — this is what promotes a candidate */
    distinctDictations: integer('distinct_dictations').notNull().default(0),
    confidence: real('confidence').notNull().default(0),
    firstSeen: integer('first_seen'),
    lastSeen: integer('last_seen'),
    /** plain-English reason, shown to the user in the Memory surface */
    reason: text('reason'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    byName: index('entities_name_idx').on(t.canonicalName),
    byStatus: index('entities_status_idx').on(t.status),
  })
);

export const entityMentions = sqliteTable(
  'entity_mentions',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    dictationId: text('dictation_id')
      .notNull()
      .references(() => dictations.id, { onDelete: 'cascade' }),
    surfaceForm: text('surface_form').notNull(),
    snippet: text('snippet').notNull(),
    spokenAt: integer('spoken_at').notNull(),
  },
  (t) => ({
    byEntity: index('mentions_entity_idx').on(t.entityId),
    byDictation: index('mentions_dictation_idx').on(t.dictationId),
  })
);

/** A claim about an entity, each one owned by the dictation that said it. */
export const entityFacts = sqliteTable(
  'entity_facts',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    dictationId: text('dictation_id')
      .notNull()
      .references(() => dictations.id, { onDelete: 'cascade' }),
    claim: text('claim').notNull(),
    /** 'current' | 'superseded' — later dictations can revise earlier ones */
    state: text('state').notNull().default('current'),
    supersededBy: text('superseded_by'),
    spokenAt: integer('spoken_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    byEntity: index('facts_entity_idx').on(t.entityId),
    byDictation: index('facts_dictation_idx').on(t.dictationId),
  })
);

/* --------------------------------------------------------------- PREFERENCES */

export const preferences = sqliteTable(
  'preferences',
  {
    id: text('id').primaryKey(),
    /** 'app' | 'recipient' | 'global' */
    scopeType: text('scope_type').notNull(),
    scopeValue: text('scope_value'),
    /** "Keep Slack messages to two sentences, no greeting." */
    statement: text('statement').notNull(),
    /** 'proposed' -> user must accept | 'active' | 'dismissed' */
    status: text('status').notNull().default('proposed'),
    evidenceCount: integer('evidence_count').notNull().default(0),
    confidence: real('confidence').notNull().default(0),
    reason: text('reason'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    decidedAt: integer('decided_at'),
  },
  (t) => ({ byScope: index('prefs_scope_idx').on(t.scopeType, t.scopeValue) })
);

export const preferenceEvidence = sqliteTable(
  'preference_evidence',
  {
    id: text('id').primaryKey(),
    preferenceId: text('preference_id')
      .notNull()
      .references(() => preferences.id, { onDelete: 'cascade' }),
    dictationId: text('dictation_id')
      .notNull()
      .references(() => dictations.id, { onDelete: 'cascade' }),
    /** 'correction' | 'rewrite_request' | 'explicit_instruction' */
    kind: text('kind').notNull(),
    snippet: text('snippet').notNull(),
    spokenAt: integer('spoken_at').notNull(),
  },
  (t) => ({ byPref: index('pref_evidence_idx').on(t.preferenceId) })
);

/* ------------------------------------------- WHAT WE DELIBERATELY DID NOT LEARN */

export const ignoredRecords = sqliteTable(
  'ignored_records',
  {
    id: text('id').primaryKey(),
    dictationId: text('dictation_id')
      .notNull()
      .references(() => dictations.id, { onDelete: 'cascade' }),
    /** 'no_durable_content' | 'sensitive_category' | 'transient' | 'single_mention'
     *  | 'about_third_party_private' | 'low_confidence' */
    reason: text('reason').notNull(),
    detail: text('detail'),
    /** what was on the table and got dropped, for the eval report */
    candidate: text('candidate'),
    stage: text('stage').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byReason: index('ignored_reason_idx').on(t.reason) })
);

/* ------------------------------------------------------------- AUDIT / EVENTS */

export const memoryEvents = sqliteTable(
  'memory_events',
  {
    id: text('id').primaryKey(),
    at: integer('at').notNull(),
    /** 'created' | 'reinforced' | 'updated' | 'superseded' | 'rejected' | 'deleted' | 'promoted' */
    action: text('action').notNull(),
    /** 'entity' | 'entity_fact' | 'preference' | 'dictation' */
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    targetLabel: text('target_label'),
    sourceDictationId: text('source_dictation_id'),
    reason: text('reason').notNull(),
    model: text('model'),
    tokensIn: integer('tokens_in').default(0),
    tokensOut: integer('tokens_out').default(0),
    costUsd: real('cost_usd').default(0),
    latencyMs: integer('latency_ms'),
  },
  (t) => ({
    byTarget: index('events_target_idx').on(t.targetType, t.targetId),
    byTime: index('events_at_idx').on(t.at),
  })
);

/* ------------------------------------------------------- HEY KIVI INTERACTIONS */

export const interactions = sqliteTable(
  'interactions',
  {
    id: text('id').primaryKey(),
    at: integer('at').notNull(),
    query: text('query').notNull(),
    /** context the request was made from, mirroring a real Kivi invocation */
    app: text('app'),
    selectionText: text('selection_text'),
    answer: text('answer'),
    /** What the model actually said, before the guards rewrote it. Kept because
     *  "why did Kivi refuse?" is unanswerable if the refused answer is discarded. */
    rawAnswer: text('raw_answer'),
    /** true when Kivi declined to answer for lack of grounding */
    refused: integer('refused', { mode: 'boolean' }).notNull().default(false),
    refusalReason: text('refusal_reason'),
    /** JSON array of tool calls in order */
    toolCalls: text('tool_calls').notNull().default('[]'),
    topScore: real('top_score'),
    retrievalMs: integer('retrieval_ms'),
    totalMs: integer('total_ms'),
    model: text('model'),
    tokensIn: integer('tokens_in').default(0),
    tokensOut: integer('tokens_out').default(0),
    costUsd: real('cost_usd').default(0),
    /** which eval run produced this, if any */
    evalRunId: text('eval_run_id'),
  },
  (t) => ({ byTime: index('interactions_at_idx').on(t.at) })
);

/** Everything retrieval surfaced, used or not — the inspection path. */
export const interactionCitations = sqliteTable(
  'interaction_citations',
  {
    id: text('id').primaryKey(),
    interactionId: text('interaction_id')
      .notNull()
      .references(() => interactions.id, { onDelete: 'cascade' }),
    /** 'dictation' | 'entity' | 'preference' */
    kind: text('kind').notNull(),
    refId: text('ref_id').notNull(),
    label: text('label'),
    rank: integer('rank').notNull(),
    lexicalScore: real('lexical_score').default(0),
    vectorScore: real('vector_score').default(0),
    score: real('score').notNull(),
    /** did the answer actually cite it, or was it merely retrieved? */
    used: integer('used', { mode: 'boolean' }).notNull().default(false),
    note: text('note'),
  },
  (t) => ({ byInteraction: index('citations_interaction_idx').on(t.interactionId) })
);

/* ----------------------------------------------------------------- PIPELINE */

export const ingestRuns = sqliteTable('ingest_runs', {
  id: text('id').primaryKey(),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  label: text('label'),
  sourceFile: text('source_file'),
  recordsSeen: integer('records_seen').default(0),
  recordsIngested: integer('records_ingested').default(0),
  entitiesCreated: integer('entities_created').default(0),
  entitiesPromoted: integer('entities_promoted').default(0),
  preferencesProposed: integer('preferences_proposed').default(0),
  recordsIgnored: integer('records_ignored').default(0),
  tokensIn: integer('tokens_in').default(0),
  tokensOut: integer('tokens_out').default(0),
  costUsd: real('cost_usd').default(0),
  dbBytesBefore: integer('db_bytes_before'),
  dbBytesAfter: integer('db_bytes_after'),
  wallMs: integer('wall_ms'),
});

export const evalRuns = sqliteTable('eval_runs', {
  id: text('id').primaryKey(),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  suite: text('suite'),
  totalCases: integer('total_cases').default(0),
  passed: integer('passed').default(0),
  failed: integer('failed').default(0),
  costUsd: real('cost_usd').default(0),
  notes: text('notes'),
});

export const evalResults = sqliteTable(
  'eval_results',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    caseId: text('case_id').notNull(),
    category: text('category').notNull(),
    question: text('question').notNull(),
    expectation: text('expectation').notNull(),
    interactionId: text('interaction_id'),
    passed: integer('passed', { mode: 'boolean' }).notNull(),
    verdict: text('verdict'),
    detail: text('detail'),
    latencyMs: integer('latency_ms'),
    costUsd: real('cost_usd').default(0),
  },
  (t) => ({ byRun: index('eval_results_run_idx').on(t.runId) })
);

/** Styles are user-authored, deliberate, and NOT semantic memory. Kept here so the
 *  product can show the boundary: Styles shape dictation, memory never does. */
export const styles = sqliteTable('styles', {
  id: text('id').primaryKey(),
  app: text('app').notNull(),
  name: text('name').notNull(),
  instruction: text('instruction').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** Phonetic memory: the existing spelling dictionary. Deliberately separate from
 *  semantic memory, and the ONLY memory allowed to touch ordinary dictation. */
export const phoneticEntries = sqliteTable('phonetic_entries', {
  id: text('id').primaryKey(),
  heard: text('heard').notNull(),
  written: text('written').notNull(),
  timesApplied: integer('times_applied').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});
