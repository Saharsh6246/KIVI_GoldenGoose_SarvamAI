import 'dotenv/config';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, DB_PATH, ensureFts, reindexFts } from '../src/db/client';

migrate(db, { migrationsFolder: './drizzle' });
ensureFts();
reindexFts();
console.log(`migrated  ${DB_PATH}`);
