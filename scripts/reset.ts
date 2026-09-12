/**
 * Full reset. Deletes the database file and everything derived from it, then
 * recreates an empty schema. Nothing survives — which is the point: in this product
 * memory is a view over dictations, so removing the dictations removes the memory.
 */
import 'dotenv/config';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const url = process.env.DATABASE_URL ?? './data/kivi.db';
const dbPath = resolve(process.cwd(), url);
for (const suffix of ['', '-wal', '-shm']) {
  const p = dbPath + suffix;
  if (existsSync(p)) {
    rmSync(p);
    console.log(`removed ${p}`);
  }
}
mkdirSync(dirname(dbPath), { recursive: true });

const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
const { db, ensureFts } = await import('../src/db/client');
migrate(db, { migrationsFolder: './drizzle' });
ensureFts();
console.log('reset complete — empty database created');
