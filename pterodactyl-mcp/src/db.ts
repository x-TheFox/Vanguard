/**
 * Database client for Pterodactyl MCP Server
 *
 * Uses the same PostgreSQL database as the aegis workspace but with
 * its own connection pool and a minimal schema covering only
 * ptero_credentials.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });
