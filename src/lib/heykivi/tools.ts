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
import { eq } from 'drizzle-orm';
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
      'Rewrite text the person already dictated into a new form (shorter, a meeting note, an email, bullet points). Applies only preferences the person has accepted. Use for "polish it", "turn that into", "make it ready for".',
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
  if (e.kind === 'dictation') ctx.topScore = Math.max(ctx.topScore, e.score);
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

  return {
    timezone_note: 'All spoken_at values are the person\'s local time, the same clock they speak in.',
    window: window.label,
    widened: widenings.length ? widenings : undefined,
    considered: result.considered,
    matched: result.hits.length,
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

  // The rewrite itself is performed by the answering model in its final turn; this
  // tool's job is to hand it the exact source and the accepted preferences, so that
  // nothing gets applied that the person has not agreed to.
  return {
    source_dictation: sourceId,
    source_text: source,
    instruction: String(args.instruction ?? ''),
    accepted_preferences: prefs.map((p) => ({
      statement: p.statement,
      scope: p.scopeType === 'global' ? 'everywhere' : `${p.scopeType}: ${p.scopeValue}`,
      accepted_because: p.reason,
    })),
    note:
      prefs.length === 0
        ? 'No accepted preferences apply here. Rewrite plainly and do not invent a house style.'
        : 'Apply ONLY the listed preferences. They are the ones the person accepted.',
  };
}
