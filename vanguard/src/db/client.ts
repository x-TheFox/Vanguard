/**
 * Database Client — Vanguard
 *
 * Drizzle ORM client for Vanguard's database access.
 * Vanguard only writes to suggestion_threads and audit_log;
 * reads from other tables are for validation only.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });
