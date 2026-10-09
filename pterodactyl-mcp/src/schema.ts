/**
 * Minimal Drizzle ORM Schema for Pterodactyl MCP Server
 *
 * This module defines only the `ptero_credentials` table needed by the
 * MCP server for credential loading. The full schema lives in the
 * aegis workspace; this is a self-contained subset.
 */

import {
  pgEnum,
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  integer,
  timestamp,
  uniqueIndex,
  check,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const pteroCredentialTypeEnum = pgEnum('ptero_credential_type', [
  'application',
  'client',
]);

export const pteroCredentials = pgTable(
  'ptero_credentials',
  {
    credentialId: uuid('credential_id').primaryKey().defaultRandom(),
    credentialType: pteroCredentialTypeEnum('credential_type').notNull(),
    encryptedToken: text('encrypted_token').notNull(),
    tokenNonce: text('token_nonce').notNull(),
    tokenTag: text('token_tag').notNull(),
    tokenHash: text('token_hash').notNull(),
    description: text('description'),
    serverScope: jsonb('server_scope').notNull().default(sql`'[]'::jsonb`),
    permissions: jsonb('permissions').notNull().default(sql`'{}'::jsonb`),
    isActive: boolean('is_active').notNull().default(true),
    rateLimitRemaining: integer('rate_limit_remaining').default(240),
    rateLimitResetAt: timestamp('rate_limit_reset_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_token_hash').on(table.tokenHash),
    check('chk_encrypted_token_not_empty', sql`length(${table.encryptedToken}) > 0`),
    check('chk_token_hash_not_empty', sql`length(${table.tokenHash}) > 0`),
    check('chk_rate_limit_non_negative', sql`${table.rateLimitRemaining} >= 0`),
    index('idx_ptero_credentials_type_active').on(table.credentialType, table.isActive),
    index('idx_ptero_credentials_rate_limit_reset').on(table.rateLimitResetAt),
    index('idx_ptero_credentials_type_all').on(table.credentialType, table.createdAt),
  ],
);
