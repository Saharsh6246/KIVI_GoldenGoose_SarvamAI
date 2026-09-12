/**
 * OFFLINE STUB MODE — a test harness, not a demo path.
 *
 * Set KIVI_OFFLINE_STUB=1 to run the entire pipeline with deterministic, rule-based
 * stand-ins for the model. This exists so the ingest/retrieval/answer plumbing can be
 * smoke-tested in CI and on a machine with no API key or no network.
 *
 * It is OFF by default. The evaluator refuses to mark a run valid while it is on, and
 * the UI shows a banner. Nothing in the product's claimed behaviour depends on it.
 */
import { createHash } from 'node:crypto';
import { EMBEDDING_DIM, MODELS, normalise, type Usage } from './llm';
import type { DictationForExtraction, Extraction, ExtractionBatchResult } from './memory/extract';

export function isStubMode(): boolean {
  return process.env.KIVI_OFFLINE_STUB === '1';
}

function zeroUsage(model: string, latencyMs = 0): Usage {
  return { model: `${model} (STUB)`, tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs };
}

const STOP = new Set([
  'The','This','That','These','Those','And','But','For','With','From','Have','Has','Will','Would',
  'Should','Could','Just','Also','They','Their','There','Here','What','When','Where','Which','Who',
  'How','Why','Our','Your','His','Her','Its','Not','Are','Was','Were','Been','Being','Can','May',
  'Hey','Hi','Hello','Thanks','Please','Okay','Yeah','Yes','No','I','Im',
]);

/** Crude but deterministic: multi-word Capitalised spans become candidate entities. */
export function stubExtract(batch: DictationForExtraction[]): ExtractionBatchResult {
  const extractions: Extraction[] = batch.map((d) => {
    const text = d.formattedText;
    const entities: Extraction['entities'] = [];
    const seen = new Set<string>();
    const re = /\b([A-Z][a-zA-Z0-9-]{2,}(?:\s+[A-Z][a-zA-Z0-9-]{2,})?)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const name = m[1].trim();
      if (STOP.has(name) || seen.has(name.toLowerCase())) continue;
      if (name.split(/\s+/).every((w) => STOP.has(w))) continue;
      seen.add(name.toLowerCase());
      const start = Math.max(0, m.index - 40);
      entities.push({
        name,
        kind: /\b(said|told|asked|met|pinged)\b/i.test(text.slice(start, m.index))
          ? 'person'
          : 'project',
        evidence: text.slice(start, Math.min(text.length, m.index + name.length + 40)).trim(),
        facts: [],
        confidence: 0.5,
      });
      if (entities.length >= 5) break;
    }

    const preferences: Extraction['preferences'] = [];
    const prefRe =
      /\b(make (?:it|that) (?:shorter|longer|more formal|casual)|don'?t (?:start|use|include)[^.?!]{0,60}|always (?:call|write|use)[^.?!]{0,60}|keep (?:it|this) [^.?!]{0,40})/gi;
    let p: RegExpExecArray | null;
    while ((p = prefRe.exec(text))) {
      preferences.push({
        scopeType: 'app',
        scopeValue: d.app,
        statement: p[1].trim(),
        kind: 'explicit_instruction',
        evidence: p[0],
        confidence: 0.5,
      });
    }
    return { dictationId: d.id, entities, preferences, ignored: [] };
  });
  return { extractions, usage: zeroUsage(MODELS.extraction) };
}

/** Hash-based pseudo-embedding: stable, cheap, and good enough to prove the
 *  vector path is wired. It is NOT semantic — bag-of-words hashing only. */
export function stubEmbed(texts: string[]): { vectors: Float32Array[]; usage: Usage } {
  const vectors = texts.map((t) => {
    const v = new Float32Array(EMBEDDING_DIM);
    for (const tok of t.toLowerCase().match(/[a-z0-9']+/g) ?? []) {
      const h = createHash('md5').update(tok).digest();
      const idx = h.readUInt32BE(0) % EMBEDDING_DIM;
      const sign = h[4] & 1 ? 1 : -1;
      v[idx] += sign;
    }
    return normalise(v);
  });
  return { vectors, usage: zeroUsage(MODELS.embedding) };
}

/** Extractive "answer": stitches the top snippets together with citations so the
 *  grounding and refusal paths can be exercised without a model. */
export function stubAnswer(
  question: string,
  passages: { id: string; text: string }[]
): { text: string; usage: Usage } {
  if (passages.length === 0) {
    return { text: "I don't have anything in your dictations about that.", usage: zeroUsage(MODELS.reasoning) };
  }
  const body = passages
    .slice(0, 3)
    .map((p) => `${p.text.slice(0, 220).trim()} [${p.id}]`)
    .join(' ');
  return { text: body, usage: zeroUsage(MODELS.reasoning) };
}
