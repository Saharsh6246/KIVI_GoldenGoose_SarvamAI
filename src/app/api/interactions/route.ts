import { NextRequest, NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db, schema } from '@/db/client';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const single = url.searchParams.get('id');
  if (single) {
    const row = db.select().from(schema.interactions).where(eq(schema.interactions.id, single)).get();
    if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const citations = db
      .select()
      .from(schema.interactionCitations)
      .where(eq(schema.interactionCitations.interactionId, single))
      .all()
      .sort((a, b) => b.score - a.score);
    const dictations = Object.fromEntries(
      citations
        .filter((c) => c.kind === 'dictation')
        .map((c) => [c.refId, db.select().from(schema.dictations).where(eq(schema.dictations.id, c.refId)).get() ?? null])
    );
    return NextResponse.json({ ...row, toolCalls: JSON.parse(row.toolCalls || '[]'), citations, dictations });
  }
  const rows = db.select().from(schema.interactions).orderBy(desc(schema.interactions.at)).limit(50).all();
  return NextResponse.json({ rows });
}
