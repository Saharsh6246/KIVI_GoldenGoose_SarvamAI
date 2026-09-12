/**
 * The Hey Kivi turn.
 *
 * A real tool-calling loop against the model. The interesting part is not the loop,
 * it is the two guards around it:
 *
 *   1. GROUNDING GUARD — the final answer is parsed for [d_...] citations, and every
 *      one is checked against what retrieval actually returned in this turn. An answer
 *      with no valid citation is not shipped as an answer; it becomes a refusal.
 *
 *   2. THRESHOLD GUARD — if nothing retrieved clears the refusal threshold, Kivi says
 *      it does not have it, rather than composing something plausible out of near-misses.
 *
 * Everything the turn touched is written to interaction_citations, used or not, so
 * "why did memory not affect this result?" is answerable after the fact.
 */
import { db, schema } from '../../db/client';
import { id } from '../ids';
import { generateWithTools, type Turn } from '../llm';
import { ANSWER_SYSTEM } from '../memory/policy';
import { REFUSAL_THRESHOLD } from '../memory/policy';
import { TOOL_SPECS, runTool, type ToolContext, type TraceEntry } from './tools';
import { isStubMode, stubAnswer } from '../stub';
import { formatLocal, formatLocalDateLong } from '../tz';

export type AskInput = {
  query: string;
  app?: string | null;
  selectionText?: string | null;
  /** pinned clock, so evaluation is reproducible */
  now?: number;
  evalRunId?: string | null;
};

export type AskResult = {
  interactionId: string;
  answer: string;
  /** what the model said before the guards touched it */
  rawAnswer: string;
  refused: boolean;
  refusalReason: string | null;
  citations: string[];
  trace: TraceEntry[];
  toolCalls: { name: string; args: any }[];
  topScore: number;
  retrievalMs: number;
  totalMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
};

const MAX_ROUNDS = 5;
const CITATION_RE = /\[([a-z]_[a-z0-9]{4,})\]/g;

export async function ask(input: AskInput): Promise<AskResult> {
  const startedAt = Date.now();
  const now = input.now ?? Date.now();

  const ctx: ToolContext = {
    now,
    app: input.app ?? null,
    selectionText: input.selectionText ?? null,
    trace: [],
    topScore: 0,
    retrievalMs: 0,
  };

  const preamble = [
    `Today is ${formatLocalDateLong(now)}, ${formatLocal(now, false)} local time. Every time you see or say is this person's local clock.`,
    input.app ? `The person is currently in ${input.app}.` : null,
    input.selectionText ? `They have this text selected:\n"""\n${input.selectionText}\n"""` : null,
    '',
    `They said: "${input.query}"`,
  ]
    .filter(Boolean)
    .join('\n');

  const turns: Turn[] = [{ role: 'user', text: preamble }];
  const toolCalls: { name: string; args: any }[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let model = '';
  let answer = '';

  if (isStubMode()) {
    // Deterministic path for smoke tests: one search, extractive answer.
    const stubArgs = { query: input.query, time_expression: input.query };
    const res: any = await runTool('search_dictations', stubArgs, ctx);
    toolCalls.push({ name: 'search_dictations', args: stubArgs });
    const passages = (res.results ?? []).map((r: any) => ({ id: r.id, text: r.text }));
    const stub = stubAnswer(input.query, ctx.topScore >= REFUSAL_THRESHOLD ? passages : []);
    answer = stub.text;
    model = stub.usage.model;
  } else {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await generateWithTools(turns, TOOL_SPECS, {
        system: ANSWER_SYSTEM,
        temperature: 0.1,
        maxOutputTokens: 1600,
      });
      tokensIn += res.usage.tokensIn;
      tokensOut += res.usage.tokensOut;
      costUsd += res.usage.costUsd;
      model = res.usage.model;

      if (res.calls.length === 0) {
        answer = res.text.trim();
        break;
      }
      // Replay the model's own parts verbatim — they carry Gemini's thought signatures.
      turns.push({ role: 'model', parts: res.parts });
      for (const call of res.calls) {
        toolCalls.push(call);
        let out: unknown;
        try {
          out = await runTool(call.name, call.args, ctx);
        } catch (e: any) {
          out = { error: e?.message ?? String(e) };
        }
        turns.push({ role: 'tool', name: call.name, response: out });
      }
      if (round === MAX_ROUNDS - 1) {
        // Out of rounds: ask for a final answer with no tools available.
        const final = await generateWithTools(
          [...turns, { role: 'user', text: 'Answer now from what you have, or say you do not have it.' }],
          [],
          { system: ANSWER_SYSTEM, temperature: 0.1, maxOutputTokens: 1200 }
        );
        tokensIn += final.usage.tokensIn;
        tokensOut += final.usage.tokensOut;
        costUsd += final.usage.costUsd;
        answer = final.text.trim();
      }
    }
  }

  /* ---------------------------------------------------------- guards */

  const rawAnswer = answer;
  const retrievedIds = new Set(ctx.trace.map((t) => t.refId));
  const cited: string[] = [];
  for (const m of answer.matchAll(CITATION_RE)) {
    if (retrievedIds.has(m[1])) cited.push(m[1]);
  }
  const uniqueCited = [...new Set(cited)];

  // Strip citations the answer invented — they point at nothing.
  const hallucinatedCitations = [...answer.matchAll(CITATION_RE)]
    .map((m) => m[1])
    .filter((c) => !retrievedIds.has(c));

  let refused = false;
  let refusalReason: string | null = null;
  let citedIds = uniqueCited;

  /**
   * Citation repair.
   *
   * A smaller model will sometimes answer correctly from the retrieved dictations and
   * simply omit the ids. Discarding that answer is the wrong trade: the grounding is
   * real, only the formatting failed. So when retrieval cleared the threshold and the
   * answer reads as an answer, we spend ONE more call asking for the same answer with
   * ids attached — and we hand it the only ids it is allowed to use.
   *
   * This repairs formatting, never content: the repaired answer is re-checked by the
   * same guard below, and an answer that still cannot cite is still refused.
   */
  const looksLikeRefusalEarly =
    /\b(i don'?t have|i do not have|nothing in your dictations|no dictation|couldn'?t find|can'?t find|didn'?t say anything|no record of)\b/i.test(
      answer
    );
  if (
    !isStubMode() &&
    citedIds.length === 0 &&
    answer.trim().length > 0 &&
    !looksLikeRefusalEarly &&
    ctx.topScore >= REFUSAL_THRESHOLD
  ) {
    const allowed = ctx.trace.filter((t) => t.kind === 'dictation').map((t) => t.refId);
    try {
      const repair = await generateWithTools(
        [
          ...turns,
          {
            role: 'user',
            text:
              `Your answer had no dictation ids, so it cannot be verified.\n\n` +
              `Rewrite exactly the same answer, changing nothing except that every factual ` +
              `sentence now ends with the id of the dictation it came from, in square brackets.\n` +
              `The only ids you may use: ${allowed.join(', ')}\n` +
              `If none of them actually support what you wrote, say you do not have it instead.\n\n` +
              `Your answer was:\n${answer}`,
          },
        ],
        [],
        { system: ANSWER_SYSTEM, temperature: 0, maxOutputTokens: 1200 }
      );
      tokensIn += repair.usage.tokensIn;
      tokensOut += repair.usage.tokensOut;
      costUsd += repair.usage.costUsd;
      const repaired = repair.text.trim();
      const repairedCites = [
        ...new Set([...repaired.matchAll(CITATION_RE)].map((m) => m[1]).filter((c) => retrievedIds.has(c))),
      ];
      if (repairedCites.length > 0) {
        answer = repaired;
        citedIds = repairedCites;
      }
    } catch {
      // Repair is best effort. If it fails the guard below refuses, as it should.
    }
  }

  const looksLikeRefusal =
    /\b(i don'?t have|i do not have|nothing in your dictations|no dictation|couldn'?t find|can'?t find|didn'?t say anything|no record of)\b/i.test(
      answer
    );

  if (ctx.topScore < REFUSAL_THRESHOLD && !looksLikeRefusal) {
    refused = true;
    refusalReason = `Nothing retrieved cleared the grounding threshold (best score ${ctx.topScore.toFixed(
      2
    )} < ${REFUSAL_THRESHOLD}).`;
    answer =
      "I don't have anything in your dictations about that.";
  } else if (looksLikeRefusal) {
    refused = true;
    refusalReason = 'Model found no answer in the retrieved dictations.';
  } else if (citedIds.length === 0 && !isStubMode()) {
    refused = true;
    refusalReason =
      'The answer cited no dictation, so it could not be verified against what you actually said.';
    answer =
      "I can't answer that from your dictations — I found related material but nothing that actually says it.";
  } else if (hallucinatedCitations.length > 0) {
    refusalReason = `Dropped ${hallucinatedCitations.length} citation(s) that pointed at nothing: ${hallucinatedCitations.join(', ')}.`;
    for (const bad of hallucinatedCitations) answer = answer.replaceAll(`[${bad}]`, '');
  }

  /* ---------------------------------------------------------- persist */

  const interactionId = id('i');
  const totalMs = Date.now() - startedAt;

  db.insert(schema.interactions)
    .values({
      id: interactionId,
      at: startedAt,
      query: input.query,
      app: input.app ?? null,
      selectionText: input.selectionText ?? null,
      answer,
      rawAnswer,
      refused,
      refusalReason,
      toolCalls: JSON.stringify(toolCalls),
      topScore: ctx.topScore,
      retrievalMs: ctx.retrievalMs,
      totalMs,
      model,
      tokensIn,
      tokensOut,
      costUsd,
      evalRunId: input.evalRunId ?? null,
    })
    .run();

  const usedSet = new Set(citedIds);
  for (const t of ctx.trace) {
    db.insert(schema.interactionCitations)
      .values({
        id: id('c'),
        interactionId,
        kind: t.kind,
        refId: t.refId,
        label: t.label,
        rank: t.rank,
        lexicalScore: t.lexicalScore,
        vectorScore: t.vectorScore,
        score: t.score,
        used: t.kind === 'dictation' ? usedSet.has(t.refId) : true,
        note: t.note ?? null,
      })
      .run();
  }

  return {
    interactionId,
    answer,
    refused,
    refusalReason,
    citations: citedIds,
    rawAnswer,
    trace: ctx.trace,
    toolCalls,
    topScore: ctx.topScore,
    retrievalMs: ctx.retrievalMs,
    totalMs,
    tokensIn,
    tokensOut,
    costUsd,
    model,
  };
}
