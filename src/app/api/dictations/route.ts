import { NextRequest, NextResponse } from 'next/server';
import { desc, eq, sql } from 'drizzle-orm';
import { db, schema, reindexFts } from '@/db/client';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const single = url.searchParams.get('id');
  if (single) {
    const row = db.select().from(schema.dictations).where(eq(schema.dictations.id, single)).get();
    if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const mentions = db.all<any>(
      sql`SELECT e.id, e.canonical_name AS name, e.status FROM entity_mentions m
          JOIN entities e ON e.id = m.entity_id WHERE m.dictation_id = ${single}`
    );
    const ignored = db.select().from(schema.ignoredRecords).where(eq(schema.ignoredRecords.dictationId, single)).all();
    return NextResponse.json({ ...row, entities: mentions, ignored });
  }

  const q = (url.searchParams.get('q') ?? '').trim();
  const app = url.searchParams.get('app');
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 40), 200);

  let rows = db.select().from(schema.dictations).orderBy(desc(schema.dictations.spokenAt)).limit(limit * 4).all();
  if (app) rows = rows.filter((r) => r.app === app);
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.formattedText.toLowerCase().includes(needle) ||
        r.rawAsr.toLowerCase().includes(needle) ||
        (r.recipient ?? '').toLowerCase().includes(needle) ||
        (r.windowTitle ?? '').toLowerCase().includes(needle)
    );
  }
  const apps = db.all<{ app: string; n: number }>(sql`SELECT app, count(*) AS n FROM dictations GROUP BY app ORDER BY n DESC`);
  return NextResponse.json({ rows: rows.slice(0, limit), total: rows.length, apps });
}

/**
 * Deleting a dictation deletes everything derived from it.
 *
 * The response says exactly what went with it, because the promise that forgetting
 * is real is only credible if the person can see it happen.
 */
export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const target = url.searchParams.get('id');
  if (!target) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const mentions = db.all<any>(
    sql`SELECT e.id, e.canonical_name AS name, e.distinct_dictations AS n FROM entity_mentions m
        JOIN entities e ON e.id = m.entity_id WHERE m.dictation_id = ${target}`
  );
  const facts = db.select().from(schema.entityFacts).where(eq(schema.entityFacts.dictationId, target)).all();
  const prefEvidence = db.select().from(schema.preferenceEvidence).where(eq(schema.preferenceEvidence.dictationId, target)).all();

  db.delete(schema.dictations).where(eq(schema.dictations.id, target)).run();

  // Anything that no longer has evidence no longer exists. Demotion, not tombstoning.
  const demoted: string[] = [];
  const removed: string[] = [];
  for (const e of db.select().from(schema.entities).all()) {
    const n = db.get<{ n: number }>(
      sql`SELECT count(distinct dictation_id) AS n FROM entity_mentions WHERE entity_id = ${e.id}`
    )!.n;
    if (n === 0) {
      db.delete(schema.entities).where(eq(schema.entities.id, e.id)).run();
      removed.push(e.canonicalName);
    } else if (n < 2 && e.status === 'active') {
      db.update(schema.entities)
        .set({ status: 'candidate', distinctDictations: n, reason: 'Demoted: the dictation that confirmed it was deleted.' })
        .where(eq(schema.entities.id, e.id))
        .run();
      demoted.push(e.canonicalName);
    } else if (n !== e.distinctDictations) {
      db.update(schema.entities).set({ distinctDictations: n }).where(eq(schema.entities.id, e.id)).run();
    }
  }
  for (const p of db.select().from(schema.preferences).all()) {
    const n = db.get<{ n: number }>(
      sql`SELECT count(distinct dictation_id) AS n FROM preference_evidence WHERE preference_id = ${p.id}`
    )!.n;
    if (n === 0) db.delete(schema.preferences).where(eq(schema.preferences.id, p.id)).run();
    else db.update(schema.preferences).set({ evidenceCount: n }).where(eq(schema.preferences.id, p.id)).run();
  }
  reindexFts();

  return NextResponse.json({
    deleted: target,
    alsoRemoved: {
      mentions: mentions.length,
      facts: facts.length,
      preferenceEvidence: prefEvidence.length,
      entitiesRemoved: removed,
      entitiesDemoted: demoted,
    },
  });
}
