/**
 * The Hey Kivi toolset.
 *
 * Four tools, chosen because the three use cases need exactly these and nothing else:
 *
 *   search_dictations  find things you said          (episodic recall — the spine)
 *   get_dictation      read one back in full         (so an answer can quote it)
 *   lookup_entity      what do I know about X        (the fact layer, with provenance)
 *   draft_from         reuse something you said      (the polish/rewrite use case)
 *
 * Every tool call appends to a trace so an engineer can see exactly what memory was
 * on the table, what it scored, and whether the answer ended up using it.
 */
import { db, schema } from '../../db/client';
import { retrieveDictations, lookupEntity, activePreferences, type StructuralFilter } from '../retrieval';
import { parseTimeExpression, widen } from './time';
import { eq, sql } from 'drizzle-orm';
import type { ToolSpec } from '../llm';
import { formatLocal, TZ_OFFSET_MIN } from '../tz';

export type TraceEntry = {
  kind: 'dictation' | 'entity' | 'preference';
  refId: string;
  label: string;
  rank: number;
  lexicalScore: number;
  vectorScore: number;
  score: number;
  note?: string;
  /**
   * Supplementary context — a revision candidate, or a fact pulled in to ground a draft —
   * rather than a retrieval hit for the question asked. It is shown to the model and
   * recorded in the trace, but it must NOT raise the grounding score: "there exist later
   * dated statements about Priya" is not evidence that Kivi knows Priya's phone number.
   * Letting it count turned a correct refusal into an answer.
   */
  supplementary?: boolean;
};

export type ToolContext = {
  /** "now" for time parsing — pinned during evaluation so runs are reproducible */
  now: number;
  app?: string | null;
  selectionText?: string | null;
  trace: TraceEntry[];
  /** highest blended retrieval score seen across all searches in this interaction */
  topScore: number;
  retrievalMs: number;
};

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'search_dictations',
    description:
      "Search everything the person has dictated. Use this for any question about what they said, wrote, told someone, or sent. You may combine a topic query with filters. Returns dictation ids you must cite. All times in and out of this tool are the person's own local clock.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Topic words to search for. Use the person\'s own vocabulary. May be empty if you are only filtering by time or app.',
        },
        time_expression: {
          type: 'string',
          description:
            'The time phrase exactly as the person said it, e.g. "around 5pm yesterday", "last Tuesday", "last week". Leave empty if they did not mention time.',
        },
        app: {
          type: 'string',
          description: 'Restrict to one application, e.g. Slack, Mail, Cursor, Notion, Linear.',
        },
        recipient: { type: 'string', description: 'Restrict to dictations addressed to this person.' },
        limit: { type: 'number', description: 'How many to return. Default 8.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_dictation',
    description:
      'Read one dictation in full, including the raw speech before formatting. Use before quoting or rewriting it.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The dictation id, e.g. d_4f21ab.' } },
      required: ['id'],
    },
  },
  {
    name: 'lookup_entity',
    description:
      'Look up what Kivi knows about a named person, project, product, repo or tool, with the dictations that established it. Returns nothing if the name was never confirmed by repetition.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The name as the person said it.' } },
      required: ['name'],
    },
  },
  {
    name: 'draft_from',
    description:
      'Rewrite text the person already dictated into a new form (shorter, a meeting note, an email, bullet points). Applies only preferences the person has accepted. Use for "polish it", "turn that into", "make it ready for", "draft a mail with X". It also gathers the facts the instruction refers to — pass the instruction in the person\'s own words and it returns supporting_facts and supporting_dictations you can draw the details from.',
    parameters: {
      type: 'object',
      properties: {
        dictation_id: { type: 'string', description: 'The dictation to rewrite. Preferred over raw text.' },
        text: { type: 'string', description: 'Text to rewrite, if it did not come from a dictation.' },
        instruction: { type: 'string', description: 'What the person asked for, in their words.' },
        target_app: { type: 'string', description: 'Where the result is going, if known.' },
      },
      required: ['instruction'],
    },
  },
];

function push(ctx: ToolContext, e: TraceEntry) {
  ctx.trace.push(e);
  if (e.kind === 'dictation' && !e.supplementary) ctx.topScore = Math.max(ctx.topScore, e.score);
}

export async function runTool(name: string, args: any, ctx: ToolContext): Promise<unknown> {
  switch (name) {
    case 'search_dictations':
      return searchDictations(args, ctx);
    case 'get_dictation':
      return getDictation(args, ctx);
    case 'lookup_entity':
      return lookupEntityTool(args, ctx);
    case 'draft_from':
      return draftFrom(args, ctx);
    default:
      return { error: `Unknown tool ${name}` };
  }
}

async function searchDictations(args: any, ctx: ToolContext) {
  const query: string = String(args.query ?? '').trim();
  const limit = Math.min(Number(args.limit ?? 8) || 8, 15);

  let window = args.time_expression
    ? parseTimeExpression(String(args.time_expression), ctx.now)
    : { after: null, before: null, label: null };

  const filter: StructuralFilter = {
    app: args.app ? String(args.app) : null,
    recipient: args.recipient ? String(args.recipient) : null,
    after: window.after,
    before: window.before,
    centre: window.centre ?? null,
  };

  let result = await retrieveDictations(query || (args.app ?? ''), filter, limit);
  const widenings: string[] = [];

  // A time window that finds nothing is widened once or twice before giving up.
  // This is the difference between "I don't have that" and "you said it at 5:40, not 5:00".
  let guard = 0;
  while (result.hits.length === 0 && guard++ < 2) {
    const next = widen(window);
    if (!next) break;
    window = next;
    widenings.push(next.label ?? 'wider window');
    result = await retrieveDictations(query || (args.app ?? ''), { ...filter, after: window.after, before: window.before, centre: window.centre ?? null }, limit);
  }

  ctx.retrievalMs += result.latencyMs;

  result.hits.forEach((h, i) =>
    push(ctx, {
      kind: 'dictation',
      refId: h.id,
      label: `${h.app} · ${new Date(h.spokenAt).toISOString().slice(0, 16).replace('T', ' ')}`,
      rank: i + 1,
      lexicalScore: h.lexicalScore,
      vectorScore: h.vectorScore,
      score: h.score,
    })
  );

  /**
   * Revision check, attached to every search rather than to one tool.
   *
   * The bias is a property of similarity retrieval itself, not of any one caller: a
   * superseded statement ("Confirming the go live date of 14 October") reads like a
   * direct answer, while the correction ("we are moving the go live from the 14th to
   * the 21st") reads like an aside and ranks below it — sometimes outside the top
   * fourteen. Whoever consumes search results inherits that bias, so the correction has
   * to travel with the results.
   *
   * Fires only when there is something to say: an entity named in the query, holding a
   * dated statement that is LATER than anything the search already returned for it.
   * When nothing qualifies the field is absent, so refusals and ordinary lookups are
   * untouched.
   */
  const supersededBy = revisionCheck(query, result.hits, ctx);

  return {
    timezone_note: 'All spoken_at values are the person\'s local time, the same clock they speak in.',
    window: window.label,
    widened: widenings.length ? widenings : undefined,
    considered: result.considered,
    matched: result.hits.length,
    ...(supersededBy.length
      ? {
          later_statements_you_must_check: supersededBy,
          revision_warning:
            'These were said LATER than the search results above and carry a date or number about ' +
            'the same subject. Before you state any date or number, check whether one of these ' +
            'changed it. The most recent statement wins. If it did change, use the newer value and ' +
            'say in one clause that it moved.',
        }
      : {}),
    results: result.hits.map((h) => ({
      id: h.id,
      // The person's own clock. Filtering already happens in their timezone; showing the
      // model UTC here made it read a 17:04 dictation as 11:34 and correctly conclude that
      // nothing was said at 5 PM. Same clock everywhere, or the reasoning is sound on
      // corrupted input — the worst kind of wrong answer.
      spoken_at: formatLocal(h.spokenAt),
      app: h.app,
      to: h.recipient,
      window_title: h.windowTitle,
      text: h.formattedText,
      score: Number(h.score.toFixed(3)),
    })),
  };
}

function getDictation(args: any, ctx: ToolContext) {
  const row = db.select().from(schema.dictations).where(eq(schema.dictations.id, String(args.id))).get();
  if (!row) return { error: 'No dictation with that id.' };
  push(ctx, {
    kind: 'dictation',
    refId: row.id,
    label: `${row.app} · full read`,
    rank: 0,
    lexicalScore: 0,
    vectorScore: 0,
    score: 1,
    note: 'fetched in full',
  });
  return {
    id: row.id,
    spoken_at: formatLocal(row.spokenAt),
    app: row.app,
    to: row.recipient,
    window_title: row.windowTitle,
    style_used: row.styleUsed,
    raw_speech: row.rawAsr,
    text: row.formattedText,
  };
}

function lookupEntityTool(args: any, ctx: ToolContext) {
  const found = lookupEntity(String(args.name ?? ''));
  if (!found) {
    return {
      found: false,
      note: 'Kivi has no confirmed memory of that name. It may have been said once; a single mention is not enough for Kivi to hold it as a fact. Search the dictations instead.',
    };
  }
  const { entity, facts, mentions } = found;
  if (entity.status !== 'active') {
    return {
      found: false,
      status: entity.status,
      note: `"${entity.canonicalName}" has been heard ${entity.distinctDictations} time(s). Kivi holds it as a candidate, not a fact. Search the dictations directly.`,
    };
  }
  push(ctx, {
    kind: 'entity',
    refId: entity.id,
    label: entity.canonicalName,
    rank: 0,
    lexicalScore: 0,
    vectorScore: 0,
    score: entity.confidence,
    note: entity.reason ?? undefined,
  });
  return {
    found: true,
    name: entity.canonicalName,
    kind: entity.kind,
    aliases: JSON.parse(entity.aliases || '[]'),
    mentioned_in_dictations: entity.distinctDictations,
    first_heard: entity.firstSeen ? new Date(entity.firstSeen).toISOString().slice(0, 10) : null,
    last_heard: entity.lastSeen ? new Date(entity.lastSeen).toISOString().slice(0, 10) : null,
    why_kivi_knows_this: entity.reason,
    facts: facts.map((f) => ({
      claim: f.claim,
      state: f.state,
      from_dictation: f.dictationId,
      said_on: new Date(f.spokenAt).toISOString().slice(0, 10),
    })),
    recent_mentions: mentions
      .sort((a, b) => b.spokenAt - a.spokenAt)
      .slice(0, 6)
      .map((m) => ({ dictation: m.dictationId, snippet: m.snippet })),
  };
}

async function draftFrom(args: any, ctx: ToolContext) {
  let source = String(args.text ?? '');
  let sourceId: string | null = null;
  if (args.dictation_id) {
    const row = db
      .select()
      .from(schema.dictations)
      .where(eq(schema.dictations.id, String(args.dictation_id)))
      .get();
    if (!row) return { error: 'No dictation with that id.' };
    source = row.formattedText;
    sourceId = row.id;
    push(ctx, {
      kind: 'dictation',
      refId: row.id,
      label: `${row.app} · source for draft`,
      rank: 0,
      lexicalScore: 0,
      vectorScore: 0,
      score: 1,
      note: 'used as the source text for a rewrite',
    });
  }
  if (!source) return { error: 'Nothing to rewrite. Pass dictation_id or text.' };

  const prefs = activePreferences(args.target_app ?? ctx.app ?? null);
  prefs.forEach((p) =>
    push(ctx, {
      kind: 'preference',
      refId: p.id,
      label: p.statement,
      rank: 0,
      lexicalScore: 0,
      vectorScore: 0,
      score: p.confidence,
      note: p.reason ?? undefined,
    })
  );

  /**
   * A draft usually needs a fact the source text does not contain.
   *
   * "Draft a mail to Sandra with the current Meridian date" is a rewrite AND a lookup.
   * Relying on the answering turn to have searched for that date first means the draft
   * is only as good as whatever the model happened to look for, and when it did not look,
   * the choice becomes: refuse, or invent a date and put it in a mail to a client.
   *
   * So the tool grounds itself. It pulls what the instruction asks about — by entity, and
   * by retrieval over the instruction — and hands it back with dictation ids attached.
   * This adds no ungrounded content: everything returned still traces to an utterance and
   * still has to be cited by the answer.
   */
  const instruction = String(args.instruction ?? '');
  const supporting = await gatherSupport(instruction, source, ctx);

  return {
    source_dictation: sourceId,
    source_text: source,
    instruction,
    accepted_preferences: prefs.map((p) => ({
      statement: p.statement,
      scope: p.scopeType === 'global' ? 'everywhere' : `${p.scopeType}: ${p.scopeValue}`,
      accepted_because: p.reason,
    })),
    supporting_facts: supporting.facts,
    supporting_dictations: supporting.dictations,
    dated_statements_by_subject: supporting.timelines,
    note:
      prefs.length === 0
        ? 'No accepted preferences apply here. Rewrite plainly and do not invent a house style.'
        : 'Apply ONLY the listed preferences. They are the ones the person accepted.',
    grounding_note:
      'supporting_facts, supporting_dictations and dated_statements_by_subject are everything Kivi ' +
      'holds that bears on this instruction. If the instruction asks for a detail (a date, a name, ' +
      'a number), take it from there and cite the dictation id.\n' +
      'CHECK dated_statements_by_subject BEFORE committing to any date or number: it is ordered ' +
      'newest first and exists precisely to catch a value that was later changed. When two entries ' +
      'disagree, the later said_on wins, and say so in one clause so the person can see the change.\n' +
      'If the detail is genuinely absent, name which one and do not write the draft around a guess — ' +
      'an invented detail in a message that is about to be sent is worse than no draft.',
  };
}

/**
 * For entities named in the query, find dated statements LATER than whatever the search
 * already surfaced for that entity. Returns nothing unless a genuine revision candidate
 * exists, so it cannot quietly widen an answer that should have been a refusal.
 */
function revisionCheck(
  query: string,
  hits: { id: string; spokenAt: number }[],
  ctx: ToolContext
): any[] {
  if (!query.trim()) return [];
  const names = [...new Set((query.match(/\b[A-Z][a-zA-Z0-9-]{2,}(?:\s+[A-Z][a-zA-Z0-9-]{2,})?\b/g) ?? []))]
    .filter((n) => !INSTRUCTION_STOPWORDS.has(n))
    .slice(0, 3);
  if (names.length === 0) return [];

  const already = new Set(hits.map((h) => h.id));
  const newestReturned = hits.length ? Math.max(...hits.map((h) => h.spokenAt)) : 0;
  const out: any[] = [];

  for (const name of names) {
    const found = lookupEntity(name);
    if (!found || found.entity.status !== 'active') continue;

    const rows = db.all<any>(sql`
      SELECT d.id, d.spoken_at AS spokenAt, d.app, d.formatted_text AS text
      FROM entity_mentions m JOIN dictations d ON d.id = m.dictation_id
      WHERE m.entity_id = ${found.entity.id}
      ORDER BY d.spoken_at DESC`);

    const candidates = rows
      .filter((r) => !already.has(r.id) && STRONG_DETAIL.test(r.text) && r.spokenAt > oldestDatedHit(hits, rows))
      .slice(0, 4);

    for (const r of candidates) {
      push(ctx, {
        kind: 'dictation',
        refId: r.id,
        label: `${r.app} · later statement about ${found.entity.canonicalName}`,
        rank: 0,
        lexicalScore: 0,
        vectorScore: 0,
        score: 0.6,
        supplementary: true,
        note: 'surfaced by the revision check: newer, and carries a date or number about the same subject',
      });
      out.push({
        id: r.id,
        about: found.entity.canonicalName,
        said_on: formatLocal(r.spokenAt),
        app: r.app,
        text: String(r.text).slice(0, 320),
      });
    }
  }
  void newestReturned;
  return out.slice(0, 6);
}

/** The earliest dated result we returned — anything newer than it could revise it. */
function oldestDatedHit(hits: { id: string; spokenAt: number }[], _rows: unknown): number {
  if (!hits.length) return 0;
  return Math.min(...hits.map((h) => h.spokenAt));
}

/** Capitalised multi-word spans in the instruction are the things it is asking about. */
const INSTRUCTION_STOPWORDS = new Set([
  'Draft','Write','Turn','Make','Rewrite','Send','Reply','Summarise','Summarize','Polish','Prepare',
  'The','A','An','And','Or','For','With','From','Into','About','This','That','My','Me','I',
  'Mail','Email','Message','Slack','Note','Doc','Document','Standup','Meeting','Please',
]);

/**
 * Statements that could REVISE a detail: anything mentioning the entity that carries a
 * date, a deadline, a percentage or a number.
 *
 * This exists because similarity retrieval is systematically biased against revisions.
 * "Confirming the Meridian go live date of 14 October" is a near-perfect match for
 * "draft a mail with the current Meridian date"; "we are moving the go live from the 14th
 * to the 21st" is a worse textual match and loses — so the most relevant-looking dictation
 * is the out-of-date one. Ranking by similarity alone would have Kivi write a client a
 * confident mail containing a date that was changed three weeks ago.
 *
 * So revisions are gathered structurally, by entity and recency, never by similarity.
 */
/** A commitment or a number: the kind of statement a draft would quote. */
const STRONG_DETAIL =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}(?:st|nd|rd|th)\b|go live|deadline|due|ships?|shipping|launch|moving|moved|postpon|delay|reschedul|instead of|no longer|cut|slipp?ed|\d+\s*(?:percent|%)|Q[1-4])\b/i;
/** Weaker: a weekday or a bare time. Useful context, but never outranks a commitment. */
const WEAK_DETAIL = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|\d{1,2}:\d{2})\b/i;

function datedStatements(entityId: string, ctx: ToolContext, label: string) {
  const rows = db.all<any>(sql`
    SELECT d.id, d.spoken_at AS spokenAt, d.app, d.formatted_text AS text
    FROM entity_mentions m JOIN dictations d ON d.id = m.dictation_id
    WHERE m.entity_id = ${entityId}
    ORDER BY d.spoken_at DESC`);

  // Commitments first, then weaker context — each newest-first. A revision must never be
  // pushed out of the window by twenty "heads down until Thursday" messages.
  const strong = rows.filter((r) => STRONG_DETAIL.test(r.text));
  const weak = rows.filter((r) => !STRONG_DETAIL.test(r.text) && WEAK_DETAIL.test(r.text));
  const out = [...strong.slice(0, 8), ...weak.slice(0, 2)];
  out.forEach((r, i) =>
    push(ctx, {
      kind: 'dictation',
      refId: r.id,
      label: `${r.app} · ${label} timeline`,
      rank: i + 1,
      lexicalScore: 0,
      vectorScore: 0,
      score: 0.6,
      supplementary: true,
      note: 'carries a date or number about this subject, so it could revise an earlier statement',
    })
  );
  return out.map((r) => ({
    id: r.id,
    said_on: formatLocal(r.spokenAt),
    app: r.app,
    text: String(r.text).slice(0, 320),
  }));
}

async function gatherSupport(instruction: string, source: string, ctx: ToolContext) {
  const facts: any[] = [];
  const timelines: Record<string, any[]> = {};
  const seenFact = new Set<string>();

  // 1. Anything named in the instruction, with its established facts.
  const names = [...new Set((instruction.match(/\b[A-Z][a-zA-Z0-9-]{2,}(?:\s+[A-Z][a-zA-Z0-9-]{2,})?\b/g) ?? []))]
    .filter((n) => !INSTRUCTION_STOPWORDS.has(n))
    .slice(0, 4);

  for (const name of names) {
    const found = lookupEntity(name);
    if (!found || found.entity.status !== 'active') continue;
    push(ctx, {
      kind: 'entity',
      refId: found.entity.id,
      label: `${found.entity.canonicalName} · gathered for draft`,
      rank: 0,
      lexicalScore: 0,
      vectorScore: 0,
      score: found.entity.confidence,
      note: 'named in the instruction, so its established facts were pulled in',
    });
    timelines[found.entity.canonicalName] = datedStatements(found.entity.id, ctx, found.entity.canonicalName);
    for (const f of [...found.facts].sort((a, b) => b.spokenAt - a.spokenAt).slice(0, 20)) {
      const key = `${found.entity.canonicalName}:${f.claim}`;
      if (seenFact.has(key)) continue;
      seenFact.add(key);
      facts.push({
        about: found.entity.canonicalName,
        claim: f.claim,
        from_dictation: f.dictationId,
        said_on: formatLocal(f.spokenAt).slice(0, 10),
      });
    }
  }

  // 2. Retrieval over the instruction itself, for details no entity carries.
  let dictations: any[] = [];
  try {
    const res = await retrieveDictations(`${instruction} ${source.slice(0, 160)}`, {}, 6);
    ctx.retrievalMs += res.latencyMs;
    res.hits.forEach((h, i) =>
      push(ctx, {
        kind: 'dictation',
        refId: h.id,
        label: `${h.app} · gathered for draft`,
        rank: i + 1,
        lexicalScore: h.lexicalScore,
        vectorScore: h.vectorScore,
        score: h.score,
        supplementary: true,
        note: 'retrieved by the draft tool to ground a detail the instruction asks for',
      })
    );
    dictations = res.hits.map((h) => ({
      id: h.id,
      said_on: formatLocal(h.spokenAt),
      app: h.app,
      text: h.formattedText.slice(0, 400),
    }));
  } catch {
    // Grounding support is best effort; the draft still has its source text.
  }

  return { facts: facts.slice(0, 30), dictations, timelines };
}
