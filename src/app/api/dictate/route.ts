import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema, reindexFts } from '@/db/client';
import { id } from '@/lib/ids';
import { generate, MODELS } from '@/lib/llm';
import { isStubMode } from '@/lib/stub';

export const dynamic = 'force-dynamic';

/**
 * Ordinary dictation.
 *
 * Note what is NOT here: no retrieval, no entities, no preferences. Formatting is
 * driven by the Style for the app and by phonetic memory, both of which the person
 * set deliberately. Semantic memory is not consulted, on purpose — see docs/vision.md.
 */
const STYLES: Record<string, string> = {
  Slack: 'Short and direct. No greeting, no sign-off. Two or three sentences at most.',
  Mail: 'Full sentences. Polite but not florid. Keep the salutation and sign off with the name.',
  Linear: 'Issue prose. Imperative mood. No pleasantries.',
  Cursor: 'Technical. Preserve identifiers, paths and commands exactly as spoken.',
  Notion: 'Structured notes. Short paragraphs, headings where they help.',
  Notes: 'Lightly cleaned up. Keep it raw.',
  Messages: 'Casual, contractions fine.',
};

export async function POST(req: NextRequest) {
  const body = await req.json();
  const rawAsr: string = String(body.raw ?? '').trim();
  const app: string = String(body.app ?? 'Slack');
  if (!rawAsr) return NextResponse.json({ error: 'Nothing was said.' }, { status: 400 });

  const phonetic = db.select().from(schema.phoneticEntries).all();
  let corrected = rawAsr;
  const appliedPhonetic: { heard: string; written: string }[] = [];
  for (const p of phonetic) {
    const re = new RegExp(`\\b${p.heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    if (re.test(corrected)) {
      corrected = corrected.replace(re, p.written);
      appliedPhonetic.push({ heard: p.heard, written: p.written });
      db.update(schema.phoneticEntries)
        .set({ timesApplied: p.timesApplied + 1 })
        .where(eq(schema.phoneticEntries.id, p.id))
        .run();
    }
  }

  const styleInstruction = STYLES[app] ?? STYLES.Notes;
  let formatted = corrected;
  let model = 'none';
  let latencyMs = 0;
  let costUsd = 0;

  if (!isStubMode()) {
    try {
      const res = await generate(
        `Style for ${app}: ${styleInstruction}\n\nRaw speech:\n"""\n${corrected}\n"""\n\nWrite what the person meant to type. Do not add information. Do not answer anything. Output only the text.`,
        {
          model: MODELS.extraction,
          system:
            'You turn dictated speech into written text. You never add content, never answer questions in the text, and never use anything you know about the person beyond the style instruction you are given.',
          temperature: 0.2,
          maxOutputTokens: 800,
        }
      );
      formatted = res.text.trim() || corrected;
      model = res.usage.model;
      latencyMs = res.usage.latencyMs;
      costUsd = res.usage.costUsd;
    } catch (e: any) {
      formatted = corrected;
      model = `unavailable (${e?.message?.slice(0, 60)})`;
    }
  } else {
    formatted = corrected.charAt(0).toUpperCase() + corrected.slice(1) + (/[.!?]$/.test(corrected) ? '' : '.');
    model = 'offline stub';
  }

  const dictationId = id('d');
  db.insert(schema.dictations)
    .values({
      id: dictationId,
      spokenAt: Date.now(),
      app,
      windowTitle: body.window ?? null,
      recipient: body.recipient ?? null,
      rawAsr,
      formattedText: formatted,
      styleUsed: `${app} — ${styleInstruction}`,
      durationMs: Math.round((rawAsr.split(/\s+/).length / 2.6) * 1000),
      lang: 'en',
      source: 'live',
      corpusId: null,
      createdAt: Date.now(),
    })
    .run();
  reindexFts();

  return NextResponse.json({
    id: dictationId,
    formatted,
    styleInstruction,
    appliedPhonetic,
    semanticMemoryUsed: false,
    model,
    latencyMs,
    costUsd,
  });
}
