/**
 * Stage 1+2 of ingestion: decide whether a dictation carries anything durable,
 * then pull structured candidates out of it.
 *
 * Both stages log their refusals. "What the system deliberately ignored" is a
 * first-class output here, not a side effect.
 */
import { generate, MODELS, type Usage } from '../llm';
import { EXTRACTION_SYSTEM, ALLOWED_ENTITY_KINDS, type IgnoreReason } from './policy';
import { isStubMode, stubExtract } from '../stub';

export type ExtractedEntity = {
  name: string;
  kind: string;
  aliases?: string[];
  /** verbatim span from the dictation that supports this */
  evidence: string;
  facts?: string[];
  confidence: number;
};

export type ExtractedPreference = {
  /** 'app' | 'recipient' | 'global' */
  scopeType: string;
  scopeValue?: string | null;
  statement: string;
  /** 'correction' | 'rewrite_request' | 'explicit_instruction' */
  kind: string;
  evidence: string;
  confidence: number;
};

export type ExtractedIgnore = { candidate: string; reason: IgnoreReason | string; detail?: string };

export type Extraction = {
  dictationId: string;
  entities: ExtractedEntity[];
  preferences: ExtractedPreference[];
  ignored: ExtractedIgnore[];
};

export type ExtractionBatchResult = { extractions: Extraction[]; usage: Usage };

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dictationId: { type: 'string' },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                kind: { type: 'string', enum: [...ALLOWED_ENTITY_KINDS] },
                aliases: { type: 'array', items: { type: 'string' } },
                evidence: { type: 'string' },
                facts: { type: 'array', items: { type: 'string' } },
                confidence: { type: 'number' },
              },
              required: ['name', 'kind', 'evidence', 'confidence'],
            },
          },
          preferences: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                scopeType: { type: 'string', enum: ['app', 'recipient', 'global'] },
                scopeValue: { type: 'string' },
                statement: { type: 'string' },
                kind: {
                  type: 'string',
                  enum: ['correction', 'rewrite_request', 'explicit_instruction'],
                },
                evidence: { type: 'string' },
                confidence: { type: 'number' },
              },
              required: ['scopeType', 'statement', 'kind', 'evidence', 'confidence'],
            },
          },
          ignored: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                candidate: { type: 'string' },
                reason: { type: 'string' },
                detail: { type: 'string' },
              },
              required: ['candidate', 'reason'],
            },
          },
        },
        required: ['dictationId', 'entities', 'preferences', 'ignored'],
      },
    },
  },
  required: ['results'],
} as const;

export type DictationForExtraction = {
  id: string;
  app: string;
  recipient: string | null;
  windowTitle: string | null;
  spokenAt: number;
  formattedText: string;
  rawAsr: string;
};

/** Cheap deterministic gate. Saves a model call on the many dictations that
 *  obviously carry nothing durable, and records why. */
export function gate(d: DictationForExtraction): { pass: boolean; reason?: IgnoreReason } {
  const text = d.formattedText.trim();
  if (text.length < 25) return { pass: false, reason: 'no_durable_content' };
  const words = text.split(/\s+/);
  if (words.length < 6) return { pass: false, reason: 'no_durable_content' };
  // Pure acknowledgements / social glue.
  if (
    /^(ok|okay|got it|thanks|thank you|sure|sounds good|will do|on it|yes|no|yep|nope|done|lgtm|ack)[\s.!,]*$/i.test(
      text
    )
  ) {
    return { pass: false, reason: 'no_durable_content' };
  }
  // A capitalised token or a number is the weakest possible signal that something
  // nameable is in here. Without one, there is nothing for an entity to be.
  const hasNameable = /\b[A-Z][a-zA-Z0-9-]{2,}\b/.test(text) || /\d/.test(text);
  if (!hasNameable) return { pass: false, reason: 'no_durable_content' };
  return { pass: true };
}

function renderDictation(d: DictationForExtraction): string {
  const when = new Date(d.spokenAt).toISOString().replace('T', ' ').slice(0, 16);
  return [
    `<dictation id="${d.id}">`,
    `app: ${d.app}`,
    d.recipient ? `to: ${d.recipient}` : null,
    d.windowTitle ? `window: ${d.windowTitle}` : null,
    `spoken_at: ${when} UTC`,
    `text: ${d.formattedText}`,
    `</dictation>`,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function extractBatch(
  batch: DictationForExtraction[]
): Promise<ExtractionBatchResult> {
  if (batch.length === 0) {
    return {
      extractions: [],
      usage: { model: MODELS.extraction, tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0 },
    };
  }
  if (isStubMode()) return stubExtract(batch);

  const prompt = [
    'Extract memory candidates from each dictation below. Return one result object per dictation, keyed by its id.',
    '',
    batch.map(renderDictation).join('\n\n'),
  ].join('\n');

  const res = await generate<{ results: Extraction[] }>(prompt, {
    model: MODELS.extraction,
    system: EXTRACTION_SYSTEM,
    jsonSchema: SCHEMA,
    temperature: 0,
    maxOutputTokens: 4096,
  });

  const byId = new Map<string, Extraction>();
  for (const r of res.json?.results ?? []) {
    if (!r?.dictationId) continue;
    byId.set(r.dictationId, {
      dictationId: r.dictationId,
      entities: (r.entities ?? []).filter(
        (e) => e.name && (ALLOWED_ENTITY_KINDS as readonly string[]).includes(e.kind)
      ),
      preferences: r.preferences ?? [],
      ignored: r.ignored ?? [],
    });
  }
  // Any dictation the model silently dropped is an empty extraction, not a missing one.
  const extractions = batch.map(
    (d) => byId.get(d.id) ?? { dictationId: d.id, entities: [], preferences: [], ignored: [] }
  );
  return { extractions, usage: res.usage };
}
