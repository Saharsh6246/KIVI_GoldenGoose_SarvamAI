/**
 * Gemini access layer.
 *
 * Deliberately written against the REST API with plain fetch rather than an SDK:
 * the reviewing agent clones this repo and runs it literally, and a pinned SDK
 * version is one more thing that can break. fetch is in the runtime.
 *
 * Every call returns usage so that cost, tokens and latency can be attributed to
 * the memory it produced or the answer it gave.
 */
import 'dotenv/config';
import { rateLimited, retryDelayFromBody } from './ratelimit';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const MODELS = {
  reasoning: process.env.KIVI_MODEL_REASONING ?? 'gemini-3.5-flash-lite',
  extraction: process.env.KIVI_MODEL_EXTRACTION ?? 'gemini-3.5-flash-lite',
  embedding: process.env.KIVI_MODEL_EMBEDDING ?? 'gemini-embedding-001',
};

export const EMBEDDING_DIM = Number(process.env.KIVI_EMBEDDING_DIM ?? 768);

/** USD per 1M tokens. Used for reporting only; override via env if pricing moves. */
const PRICING: Record<string, { in: number; out: number }> = {
  'gemini-3.5-flash': { in: 0.3, out: 2.5 },
  'gemini-3.5-flash-lite': { in: 0.1, out: 0.4 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gemini-embedding-001': { in: 0.15, out: 0 },
};

export function priceOf(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[model] ?? { in: 0.3, out: 2.5 };
  return (tokensIn / 1e6) * p.in + (tokensOut / 1e6) * p.out;
}

export class MissingKeyError extends Error {
  constructor() {
    super(
      'GEMINI_API_KEY is not set. Copy .env.example to .env and add a key from https://aistudio.google.com/apikey'
    );
  }
}

function apiKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k || k === 'your_key_here') throw new MissingKeyError();
  return k;
}

export type Usage = {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
};

export type GenerateOptions = {
  model?: string;
  system?: string;
  temperature?: number;
  /** A JSON Schema. When present the model is forced to emit conforming JSON. */
  jsonSchema?: unknown;
  maxOutputTokens?: number;
  retries?: number;
};

export type GenerateResult<T = string> = { text: string; json?: T; usage: Usage };

const MAX_RETRIES = Number(process.env.KIVI_MAX_RETRIES ?? 6);

/**
 * Every request goes through the rate-limit gate, and a 429 is retried with the delay
 * Gemini itself asks for. A run that is slow is fine; a run that silently drops
 * batches is not, because the resulting memory is incomplete in ways nobody can see.
 */
async function postWithRetry(url: string, body: unknown, retries = MAX_RETRIES): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await rateLimited(() =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
      if (res.status === 429 || res.status >= 500) {
        if (attempt === retries) return res;
        const text = await res.clone().text();
        const asked = res.status === 429 ? retryDelayFromBody(text) : null;
        const wait = asked ?? Math.min(2 ** attempt * 2000, 60_000);
        await new Promise((r) => setTimeout(r, wait + 250));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 30_000)));
    }
  }
  throw lastErr;
}

export async function generate<T = unknown>(
  prompt: string,
  opts: GenerateOptions = {}
): Promise<GenerateResult<T>> {
  const model = opts.model ?? MODELS.reasoning;
  const started = Date.now();

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
      maxOutputTokens: opts.maxOutputTokens ?? 2048,
      ...(opts.jsonSchema
        ? { responseMimeType: 'application/json', responseSchema: opts.jsonSchema }
        : {}),
    },
  };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };

  const res = await postWithRetry(
    `${BASE}/models/${model}:generateContent?key=${apiKey()}`,
    body,
    opts.retries ?? MAX_RETRIES
  );

  const latencyMs = Date.now() - started;
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini ${res.status} on ${model}: ${detail.slice(0, 400)}`);
  }
  const data: any = await res.json();

  const text: string =
    data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
  const tokensIn = data?.usageMetadata?.promptTokenCount ?? 0;
  const tokensOut = data?.usageMetadata?.candidatesTokenCount ?? 0;

  const usage: Usage = {
    model,
    tokensIn,
    tokensOut,
    costUsd: priceOf(model, tokensIn, tokensOut),
    latencyMs,
  };

  let json: T | undefined;
  if (opts.jsonSchema) {
    try {
      json = JSON.parse(text) as T;
    } catch {
      const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (m) {
        try {
          json = JSON.parse(m[0]) as T;
        } catch {
          /* leave undefined; caller decides */
        }
      }
    }
  }
  return { text, json, usage };
}

/* --------------------------------------------------------------- EMBEDDINGS */

export async function embedBatch(
  texts: string[],
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' = 'RETRIEVAL_DOCUMENT'
): Promise<{ vectors: Float32Array[]; usage: Usage }> {
  if (texts.length === 0) {
    return {
      vectors: [],
      usage: { model: MODELS.embedding, tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0 },
    };
  }
  const started = Date.now();
  const body = {
    requests: texts.map((t) => ({
      model: `models/${MODELS.embedding}`,
      content: { parts: [{ text: t.slice(0, 8000) }] },
      taskType,
      outputDimensionality: EMBEDDING_DIM,
    })),
  };
  const res = await postWithRetry(
    `${BASE}/models/${MODELS.embedding}:batchEmbedContents?key=${apiKey()}`,
    body
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini embed ${res.status}: ${detail.slice(0, 400)}`);
  }
  const data: any = await res.json();
  const vectors: Float32Array[] = (data.embeddings ?? []).map((e: any) =>
    normalise(Float32Array.from(e.values ?? []))
  );
  const approxTokens = texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
  return {
    vectors,
    usage: {
      model: MODELS.embedding,
      tokensIn: approxTokens,
      tokensOut: 0,
      costUsd: priceOf(MODELS.embedding, approxTokens, 0),
      latencyMs: Date.now() - started,
    },
  };
}

export function normalise(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Vectors are stored normalised, so dot product is cosine similarity. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function packVector(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

export function unpackVector(s: string): Float32Array {
  const buf = Buffer.from(s, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export async function llmHealthcheck(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await generate('Reply with the single word: ready', {
      model: MODELS.extraction,
      maxOutputTokens: 16,
    });
    return { ok: true, detail: `${r.usage.model} responded in ${r.usage.latencyMs}ms` };
  } catch (e: any) {
    return { ok: false, detail: e?.message ?? String(e) };
  }
}

/* ------------------------------------------------------------ FUNCTION CALLING */

export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type Turn =
  | { role: 'user'; text: string }
  /**
   * `parts` is the model's own response parts, replayed VERBATIM.
   *
   * Gemini 3.x attaches a signed `thoughtSignature` to each functionCall part and
   * rejects the next turn if it is missing. Reconstructing the turn from name+args
   * drops it, so the second tool round always fails with a 400. Keep the raw parts.
   */
  | { role: 'model'; parts: any[] }
  | { role: 'tool'; name: string; response: unknown };

export type ToolTurnResult = {
  text: string;
  calls: { name: string; args: any }[];
  /** raw response parts, to be replayed on the next turn */
  parts: any[];
  usage: Usage;
};

function toContents(turns: Turn[]) {
  return turns.map((t) => {
    if (t.role === 'user') return { role: 'user', parts: [{ text: t.text }] };
    if (t.role === 'model') return { role: 'model', parts: t.parts.length ? t.parts : [{ text: '' }] };
    return {
      role: 'user',
      parts: [{ functionResponse: { name: t.name, response: { result: t.response } } }],
    };
  });
}

export async function generateWithTools(
  turns: Turn[],
  tools: ToolSpec[],
  opts: { model?: string; system?: string; temperature?: number; maxOutputTokens?: number } = {}
): Promise<ToolTurnResult> {
  const model = opts.model ?? MODELS.reasoning;
  const started = Date.now();

  const body: Record<string, unknown> = {
    contents: toContents(turns),
    tools: tools.length
      ? [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          },
        ]
      : undefined,
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
      maxOutputTokens: opts.maxOutputTokens ?? 2048,
    },
  };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };

  const res = await postWithRetry(
    `${BASE}/models/${model}:generateContent?key=${apiKey()}`,
    body
  );
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini ${res.status} on ${model}: ${detail.slice(0, 400)}`);
  }
  const data: any = await res.json();
  const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? '').join('');
  const calls = parts
    .filter((p) => p.functionCall)
    .map((p) => ({ name: p.functionCall.name as string, args: p.functionCall.args ?? {} }));

  const tokensIn = data?.usageMetadata?.promptTokenCount ?? 0;
  const tokensOut = data?.usageMetadata?.candidatesTokenCount ?? 0;
  return {
    text,
    calls,
    parts,
    usage: { model, tokensIn, tokensOut, costUsd: priceOf(model, tokensIn, tokensOut), latencyMs },
  };
}
