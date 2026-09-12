import { NextResponse } from 'next/server';
import { desc, eq, sql } from 'drizzle-orm';
import { db, schema, dbBytes } from '@/db/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  const entities = db
    .select()
    .from(schema.entities)
    .orderBy(desc(schema.entities.distinctDictations))
    .all()
    .map((e) => ({
      ...e,
      aliases: JSON.parse(e.aliases || '[]'),
      mentions: db
        .select()
        .from(schema.entityMentions)
        .where(eq(schema.entityMentions.entityId, e.id))
        .all()
        .sort((a, b) => b.spokenAt - a.spokenAt)
        .slice(0, 8),
      facts: db.select().from(schema.entityFacts).where(eq(schema.entityFacts.entityId, e.id)).all(),
    }));

  const preferences = db
    .select()
    .from(schema.preferences)
    .all()
    .map((p) => ({
      ...p,
      evidence: db
        .select()
        .from(schema.preferenceEvidence)
        .where(eq(schema.preferenceEvidence.preferenceId, p.id))
        .all(),
    }));

  const ignored = db
    .select({
      id: schema.ignoredRecords.id,
      reason: schema.ignoredRecords.reason,
      detail: schema.ignoredRecords.detail,
      candidate: schema.ignoredRecords.candidate,
      stage: schema.ignoredRecords.stage,
      dictationId: schema.ignoredRecords.dictationId,
    })
    .from(schema.ignoredRecords)
    .limit(400)
    .all();

  const ignoreSummary = db.all<{ reason: string; n: number }>(
    sql`SELECT reason, count(*) AS n FROM ignored_records GROUP BY reason ORDER BY n DESC`
  );

  const events = db.select().from(schema.memoryEvents).orderBy(desc(schema.memoryEvents.at)).limit(60).all();

  const stats = db.get<any>(sql`SELECT
    (SELECT count(*) FROM dictations) AS dictations,
    (SELECT count(*) FROM entities WHERE status='active') AS activeEntities,
    (SELECT count(*) FROM entities WHERE status='candidate') AS candidateEntities,
    (SELECT count(*) FROM entity_facts) AS facts,
    (SELECT count(*) FROM ignored_records) AS ignored,
    (SELECT count(*) FROM memory_events) AS events`);

  const lastIngest = db.select().from(schema.ingestRuns).orderBy(desc(schema.ingestRuns.startedAt)).limit(1).all()[0] ?? null;

  return NextResponse.json({
    entities,
    preferences,
    ignored,
    ignoreSummary,
    events,
    stats: { ...stats, dbBytes: dbBytes() },
    lastIngest,
  });
}
