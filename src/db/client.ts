import 'dotenv/config';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema';

const url = process.env.DATABASE_URL ?? './data/kivi.db';
const dbPath = resolve(process.cwd(), url);
mkdirSync(dirname(dbPath), { recursive: true });

declare global {
  // eslint-disable-next-line no-var
  var __kivi_sqlite: Database.Database | undefined;
}

export const sqlite =
  globalThis.__kivi_sqlite ??
  (() => {
    const d = new Database(dbPath);
    d.pragma('journal_mode = WAL');
    d.pragma('foreign_keys = ON');
    return d;
  })();

if (process.env.NODE_ENV !== 'production') globalThis.__kivi_sqlite = sqlite;

export const db = drizzle(sqlite, { schema });
export { schema };
export const DB_PATH = dbPath;

export function dbBytes(): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (existsSync(p)) total += statSync(p).size;
  }
  return total;
}

/** FTS5 index over dictations. Created here rather than in Drizzle because
 *  drizzle-kit does not model virtual tables. Idempotent. */
export function ensureFts() {
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS dictations_fts USING fts5(
      formatted_text, raw_asr, window_title, recipient, app,
      content='dictations', content_rowid='rowid', tokenize='porter unicode61'
    );
  `);
}

export function reindexFts() {
  ensureFts();
  sqlite.exec(`INSERT INTO dictations_fts(dictations_fts) VALUES('rebuild');`);
}
