import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db/client';
import { id } from '@/lib/ids';

export const dynamic = 'force-dynamic';

/** Accepting or dismissing a proposal. Nothing becomes active any other way. */
export async function POST(req: NextRequest) {
  const { preferenceId, decision } = await req.json();
  if (!preferenceId || !['active', 'dismissed', 'proposed'].includes(decision))
    return NextResponse.json({ error: 'preferenceId and decision required' }, { status: 400 });

  const row = db.select().from(schema.preferences).where(eq(schema.preferences.id, preferenceId)).get();
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

  db.update(schema.preferences)
    .set({
      status: decision,
      decidedAt: decision === 'proposed' ? null : Date.now(),
      reason:
        decision === 'active'
          ? `You accepted this. Kivi will apply it when you ask it to write something.`
          : decision === 'dismissed'
            ? `You turned this down. Kivi will not offer it again.`
            : row.reason,
      updatedAt: Date.now(),
    })
    .where(eq(schema.preferences.id, preferenceId))
    .run();

  db.insert(schema.memoryEvents)
    .values({
      id: id('ev'),
      at: Date.now(),
      action: decision === 'active' ? 'updated' : 'rejected',
      targetType: 'preference',
      targetId: preferenceId,
      targetLabel: row.statement,
      reason: decision === 'active' ? 'Accepted by the person.' : 'Declined by the person.',
    })
    .run();

  return NextResponse.json({ ok: true, status: decision });
}
