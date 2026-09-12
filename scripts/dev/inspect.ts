/**
 * Ground-truth spot check.
 *
 *   npx tsx scripts/dev/inspect.ts
 *
 * Prints, in one screen, whether the things the corpus deliberately plants actually
 * made it into memory — and whether the things it plants as off-limits stayed out.
 * Faster than reading the eval when you are iterating on extraction.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, schema } from '../../src/db/client';

const line = (k: string, v: unknown) => console.log(`${k.padEnd(30)} ${v}`);

const counts = db.get<any>(sql`SELECT
  (SELECT count(*) FROM dictations) AS dictations,
  (SELECT count(*) FROM dictations WHERE processed_at IS NULL) AS unlearned,
  (SELECT count(*) FROM dictation_chunks WHERE embedding IS NULL) AS unembedded,
  (SELECT count(*) FROM entities WHERE status='active') AS active,
  (SELECT count(*) FROM entities WHERE status='candidate') AS candidates,
  (SELECT count(*) FROM entity_facts) AS facts,
  (SELECT count(*) FROM preferences) AS prefs,
  (SELECT count(*) FROM ignored_records) AS ignored`);

console.log('\n── state ───────────────────────────────────────────');
for (const [k, v] of Object.entries(counts)) line(k, v);

console.log('\n── entities that should exist ──────────────────────');
for (const name of ['Meridian', 'Tollgate', 'Blue Ledger', 'Atlas', 'Priya Raghavan', 'Karthik Nair', 'Sandra Lopez', 'Fernway']) {
  // Match in both directions: "Priya" is a correct memory of "Priya Raghavan".
  const n = name.toLowerCase();
  const hit = (v: string) => { const x = v.toLowerCase(); return x.includes(n) || n.includes(x); };
  const e = db.select().from(schema.entities).all().find((x) =>
    hit(x.canonicalName) || (JSON.parse(x.aliases || '[]') as string[]).some(hit)
  );
  line(name, e ? `${e.canonicalName} · ${e.status}  ${e.distinctDictations} dictations  ${db.get<{n:number}>(sql`SELECT count(*) AS n FROM entity_facts WHERE entity_id=${e.id}`)!.n} facts` : 'MISSING');
}

console.log('\n── entities that must NOT exist ────────────────────');
for (const bad of ['physio', 'compensation', 'salary', 'burnout', 'exhausted']) {
  const e = db.select().from(schema.entities).all().find((x) => x.canonicalName.toLowerCase().includes(bad));
  line(bad, e ? `LEAKED as "${e.canonicalName}"` : 'correctly absent');
}

console.log('\n── preferences ─────────────────────────────────────');
const prefs = db.select().from(schema.preferences).all();
if (!prefs.length) console.log('  none learned');
for (const p of prefs)
  console.log(`  [${p.status}] ${p.evidenceCount} evidence · ${p.scopeType}:${p.scopeValue ?? '*'} · ${p.statement}`);

console.log('\n── why things were left alone ──────────────────────');
for (const r of db.all<any>(sql`SELECT reason, count(*) AS n FROM ignored_records GROUP BY reason ORDER BY n DESC`))
  line(r.reason, r.n);

console.log('\n── a few facts, with provenance ────────────────────');
for (const f of db.all<any>(sql`
  SELECT e.canonical_name AS name, f.claim, f.dictation_id
  FROM entity_facts f JOIN entities e ON e.id = f.entity_id
  ORDER BY random() LIMIT 8`))
  console.log(`  ${String(f.name).padEnd(18)} ${f.claim.slice(0, 70).padEnd(72)} ${f.dictation_id}`);
console.log('');
