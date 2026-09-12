import { NextRequest, NextResponse } from 'next/server';
import { ask } from '@/lib/heykivi/agent';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** The demo clock. The corpus ends on 11 Sep 2026, so "yesterday" has to mean that day. */
const DEMO_NOW = Date.parse(process.env.KIVI_DEMO_NOW ?? '2026-09-12T09:30:00+05:30');

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const useDemoClock = body.useDemoClock !== false;
    const result = await ask({
      query: String(body.query ?? ''),
      app: body.app ?? null,
      selectionText: body.selectionText ?? null,
      now: useDemoClock ? DEMO_NOW : Date.now(),
    });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'failed' }, { status: 500 });
  }
}
