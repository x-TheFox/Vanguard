/**
 * Drizzle ORM Schema — EdenVanguard
 * Auto-generated from docs/02_database_schema.sql
 *
 * This file defines all PostgreSQL tables, enums, indexes, and
 * foreign-key relationships using Drizzle ORM's pg-core builders.
 */

import {
  pgEnum,
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  numeric,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── ENUMERATIONS ────────────────────────────────────────────

export const keyProviderEnum = pgEnum('key_provider', [
  'groq',
  'opencode_zen',
]);

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

export const deploymentStepEnum = pgEnum('deployment_step', [
  'backup_create',
  'backup_verify',
  'file_swap',
  'server_stop',
  'server_start',
  'health_check',
  'tps_validation',
  'changelog_publish',
]);

export const pteroCredentialTypeEnum = pgEnum('ptero_credential_type', [
  'application',
  'client',
]);

// ── TABLE: audit_log ────────────────────────────────────────
// Generic audit log for all mutable tables

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

// ── TABLE: api_keys ─────────────────────────────────────────
// Dynamic API Vault: stores encrypted provider tokens with quota tracking

export const apiKeys = pgTable(
  'api_keys',
  {
    keyId: uuid('key_id').primaryKey().defaultRandom(),
    provider: keyProviderEnum('provider').notNull(),
    encryptedToken: text('encrypted_token').notNull(),
    tokenNonce: text('token_nonce').notNull(),
    tokenTag: text('token_tag').notNull(),
    dailyTokenQuota: integer('daily_token_quota').notNull().default(100000),
    tokensUsed: integer('tokens_used').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    isRateLimited: boolean('is_rate_limited').notNull().default(false),
    rateLimitResetAt: timestamp('rate_limit_reset_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    donorDiscordId: text('donor_discord_id'),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('chk_quota_non_negative', sql`${table.dailyTokenQuota} >= 0`),
    check('chk_tokens_used_non_negative', sql`${table.tokensUsed} >= 0`),
    check('chk_tokens_within_quota', sql`${table.tokensUsed} <= ${table.dailyTokenQuota}`),
    index('idx_api_keys_provider_active').on(table.provider, table.isActive, table.isRateLimited),
    index('idx_api_keys_rate_limit_reset').on(table.rateLimitResetAt),
    index('idx_api_keys_provider_usage').on(table.provider, table.tokensUsed),
  ],
);

// ── TABLE: maintenance_queue ────────────────────────────────
// Tracks deployment jobs from approval through production deployment

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
    tpsAtCompletion: numeric('tps_at_completion', { precision: 5, scale: 2 }),
    healthCheckPassed: boolean('health_check_passed').default(false),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    cronExpression: text('cron_expression'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_maintenance_queue_status').on(table.status),
    index('idx_maintenance_queue_scheduled').on(table.scheduledFor),
    index('idx_maintenance_queue_executing').on(table.status, table.executionTimestamp),
  ],
);

// ── TABLE: suggestion_threads ───────────────────────────────
// Tracks Discord forum threads for mod suggestions

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

// ── TABLE: deployment_audit ─────────────────────────────────
// Append-only log of every deployment action for forensic analysis

export const deploymentAudit = pgTable(
  'deployment_audit',
  {
    auditId: uuid('audit_id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull(),
    step: deploymentStepEnum('step').notNull(),
    stepOrder: integer('step_order').notNull(),
    status: text('status').notNull(),
    details: text('details'),
    errorMessage: text('error_message'),
    pterodactylResponse: jsonb('pterodactyl_response'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.jobId],
      foreignColumns: [maintenanceQueue.jobId],
      name: 'fk_deployment_audit_job',
    }).onDelete('cascade'),
    check('chk_step_order_positive', sql`${table.stepOrder} > 0`),
    check('chk_deployment_audit_status', sql`${table.status} IN ('started', 'success', 'failed', 'skipped', 'rolled_back')`),
    index('idx_deployment_audit_job').on(table.jobId, table.stepOrder),
    index('idx_deployment_audit_status').on(table.status),
  ],
);

// ── TABLE: rate_limit_events ────────────────────────────────
// Tracks individual 429 / rate-limit events for analytics and key rotation tuning

export const rateLimitEvents = pgTable(
  'rate_limit_events',
  {
    eventId: uuid('event_id').primaryKey().defaultRandom(),
    keyId: uuid('key_id').notNull(),
    provider: keyProviderEnum('provider').notNull(),
    httpStatus: integer('http_status').notNull().default(429),
    retryAfterMs: integer('retry_after_ms'),
    errorBody: text('error_body'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.keyId],
      foreignColumns: [apiKeys.keyId],
      name: 'fk_rate_limit_events_key',
    }).onDelete('cascade'),
    index('idx_rate_limit_events_key').on(table.keyId, table.detectedAt),
    index('idx_rate_limit_events_unresolved').on(table.resolvedAt),
  ],
);

// ── TABLE: ptero_credentials ────────────────────────────────
// Dedicated Pterodactyl credential storage with AES-256-GCM encryption at rest.

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

// ── TABLE: skill_registry ───────────────────────────────────
// Tracks dynamically generated Aegis skill scripts

export const skillRegistry = pgTable(
  'skill_registry',
  {
    skillId: uuid('skill_id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    description: text('description').notNull(),
    language: text('language').notNull(),
    filePath: text('file_path').notNull(),
    version: text('version').notNull().default('1.0.0'),
    parameters: jsonb('parameters').notNull().default(sql`'[]'::jsonb`),
    author: text('author').notNull().default('aegis'),
    invocationCount: integer('invocation_count').notNull().default(0),
    lastInvokedAt: timestamp('last_invoked_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('chk_skill_language', sql`${table.language} IN ('python', 'javascript', 'bash', 'java')`),
    index('idx_skill_registry_name').on(table.name),
    index('idx_skill_registry_language').on(table.language),
    index('idx_skill_registry_active').on(table.isActive),
  ],
);

// ── TABLE: cron_jobs ────────────────────────────────────────
// Manages scheduled tasks (player monitoring, cleanup, etc.)

export const cronJobs = pgTable(
  'cron_jobs',
  {
    jobId: uuid('job_id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    description: text('description'),
    cronExpression: text('cron_expression').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    failureCount: integer('failure_count').notNull().default(0),
    maxFailures: integer('max_failures').notNull().default(3),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);
