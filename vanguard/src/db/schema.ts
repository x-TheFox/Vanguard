/**
 * Vanguard Database Schema — Minimal subset
 *
 * Vanguard only writes to suggestion_threads and audit_log.
 * The full schema lives in the aegis workspace; this is the
 * minimal set of tables Vanguard needs for its own writes.
 */

import {
  pgEnum,
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── ENUMERATIONS (must match aegis schema) ──────────────────

export const suggestionStatusEnum = pgEnum('suggestion_status', [
  'review',
  'staged',
  'deployed',
  'rejected',
  'archived',
]);

export const maintenanceJobStatusEnum = pgEnum('maintenance_job_status', [
  'pending',
  'staging',
  'ready',
  'executing',
  'completed',
  'failed',
  'rolled_back',
]);

// ── TABLE: maintenance_queue (reference only — Vanguard reads, doesn't write) ──

export const maintenanceQueue = pgTable(
  'maintenance_queue',
  {
    jobId: uuid('job_id').primaryKey().defaultRandom(),
    pterodactylServerId: text('pterodactyl_server_id').notNull(),
    targetFiles: jsonb('target_files').notNull().default(sql`'[]'::jsonb`),
    adminOverrideNotes: text('admin_override_notes'),
    approvedBy: text('approved_by').notNull(),
    status: maintenanceJobStatusEnum('status').notNull().default('pending'),
    executionTimestamp: timestamp('execution_timestamp', { withTimezone: true }),
    executionLog: jsonb('execution_log').notNull().default(sql`'[]'::jsonb`),
    backupUuid: text('backup_uuid'),
    playerCountAtExecution: integer('player_count_at_execution'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    cronExpression: text('cron_expression'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_maintenance_queue_status').on(table.status),
    index('idx_maintenance_queue_scheduled').on(table.scheduledFor),
  ],
);

// ── TABLE: suggestion_threads ───────────────────────────────

export const suggestionThreads = pgTable(
  'suggestion_threads',
  {
    threadId: text('thread_id').primaryKey(),
    originalPostId: text('original_post_id').notNull(),
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    authorDiscordId: text('author_discord_id').notNull(),
    rawSuggestionText: text('raw_suggestion_text').notNull(),
    modIdentifiers: jsonb('mod_identifiers').notNull().default(sql`'[]'::jsonb`),
    status: suggestionStatusEnum('status').notNull().default('review'),
    exclusionList: jsonb('exclusion_list').notNull().default(sql`'[]'::jsonb`),
    adminNotes: text('admin_notes'),
    approvedBy: text('approved_by'),
    rejectedBy: text('rejected_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    bytecodeAnalysis: jsonb('bytecode_analysis'),
    dependencyGraph: jsonb('dependency_graph'),
    resourceEstimate: jsonb('resource_estimate'),
    maintenanceJobId: uuid('maintenance_job_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.maintenanceJobId],
      foreignColumns: [maintenanceQueue.jobId],
      name: 'fk_suggestion_threads_maintenance_job',
    }).onDelete('set null'),
    index('idx_suggestion_threads_status').on(table.status),
    index('idx_suggestion_threads_author').on(table.authorDiscordId),
    index('idx_suggestion_threads_guild').on(table.guildId, table.status),
  ],
);

// ── TABLE: audit_log ────────────────────────────────────────

export const auditLog = pgTable(
  'audit_log',
  {
    auditId: uuid('audit_id').primaryKey().defaultRandom(),
    tableName: text('table_name').notNull(),
    recordId: uuid('record_id').notNull(),
    action: text('action').notNull(),
    changedBy: text('changed_by').notNull().default('system'),
    oldValues: jsonb('old_values'),
    newValues: jsonb('new_values'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('chk_audit_action', sql`${table.action} IN ('INSERT', 'UPDATE', 'DELETE')`),
    index('idx_audit_log_table_record').on(table.tableName, table.recordId),
    index('idx_audit_log_created_at').on(table.createdAt),
  ],
);
