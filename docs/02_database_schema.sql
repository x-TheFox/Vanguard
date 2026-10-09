-- ============================================================
-- 02 — Database Schema: EdenVanguard
-- PostgreSQL DDL — Production-Grade
-- ============================================================

-- ── EXTENSIONS ──────────────────────────────────────────────
-- Required PostgreSQL extensions

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";       -- UUID v4 generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";         -- Encryption helpers (backup for app-layer AES)

-- ── ENUMERATIONS ────────────────────────────────────────────
-- Shared enum types used across tables

CREATE TYPE key_provider AS ENUM (
    'groq',
    'opencode_zen'
);

CREATE TYPE suggestion_status AS ENUM (
    'review',       -- Initial state; awaiting Aegis evaluation
    'staged',       -- Admin-approved; queued for deployment
    'deployed',     -- Successfully deployed to production
    'rejected',     -- Rejected by admin
    'archived'      -- Duplicate or superseded; locked/archived
);

CREATE TYPE maintenance_job_status AS ENUM (
    'pending',      -- Created, awaiting zero-player window
    'staging',      -- Aegis is building the deployment payload in sandbox
    'ready',        -- Staged files are ready, waiting for player count === 0
    'executing',    -- Deployment sequence is actively running
    'completed',    -- Deployment finished successfully, server stable at 20 TPS
    'failed',       -- Deployment failed; rollback initiated
    'rolled_back'   -- Rollback completed after failure
);

CREATE TYPE deployment_step AS ENUM (
    'backup_create',
    'backup_verify',
    'file_swap',
    'server_stop',
    'server_start',
    'health_check',
    'tps_validation',
    'changelog_publish'
);

-- ── AUDIT TRAIL ─────────────────────────────────────────────
-- Generic audit log for all mutable tables

CREATE TABLE audit_log (
    audit_id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_name         TEXT NOT NULL,
    record_id          UUID NOT NULL,
    action             TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    changed_by         TEXT NOT NULL DEFAULT 'system',  -- 'vanguard' | 'aegis' | 'admin:<discord_id>'
    old_values         JSONB,
    new_values         JSONB,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_table_record ON audit_log (table_name, record_id);
CREATE INDEX idx_audit_log_created_at    ON audit_log (created_at DESC);

-- ── TABLE: api_keys ─────────────────────────────────────────
-- Dynamic API Vault: stores encrypted provider tokens with quota tracking

CREATE TABLE api_keys (
    key_id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider           key_provider NOT NULL,
    encrypted_token    TEXT NOT NULL,                -- AES-256-GCM ciphertext (base64)
    token_nonce        TEXT NOT NULL,                -- GCM nonce (base64, 12 bytes)
    token_tag          TEXT NOT NULL,                -- GCM auth tag (base64, 16 bytes)
    daily_token_quota  INTEGER NOT NULL DEFAULT 100000,
    tokens_used        INTEGER NOT NULL DEFAULT 0,
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    is_rate_limited    BOOLEAN NOT NULL DEFAULT FALSE,
    rate_limit_reset_at TIMESTAMPTZ,
    last_used_at       TIMESTAMPTZ,
    donor_discord_id   TEXT,                         -- Discord user who contributed the key
    label              TEXT,                         -- Human-readable identifier (e.g., "Groq-Key-01")
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Ensure quota is non-negative
    CONSTRAINT chk_quota_non_negative CHECK (daily_token_quota >= 0),
    CONSTRAINT chk_tokens_used_non_negative CHECK (tokens_used >= 0),
    -- Ensure tokens_used cannot exceed quota
    CONSTRAINT chk_tokens_within_quota CHECK (tokens_used <= daily_token_quota)
);

-- Indexes for round-robin load balancer: find next active, non-limited key per provider
CREATE INDEX idx_api_keys_provider_active ON api_keys (provider, is_active, is_rate_limited)
    WHERE is_active = TRUE;

-- Index for quota reset cleanup
CREATE INDEX idx_api_keys_rate_limit_reset ON api_keys (rate_limit_reset_at)
    WHERE is_rate_limited = TRUE AND rate_limit_reset_at IS NOT NULL;

-- Index for daily usage tracking
CREATE INDEX idx_api_keys_provider_usage ON api_keys (provider, tokens_used DESC)
    WHERE is_active = TRUE;

-- ── TABLE: suggestion_threads ───────────────────────────────
-- Tracks Discord forum threads for mod suggestions

CREATE TABLE suggestion_threads (
    thread_id          TEXT PRIMARY KEY,              -- Discord Thread ID (Snowflake as text)
    original_post_id   TEXT NOT NULL,                 -- Discord Message ID of the forum post
    guild_id           TEXT NOT NULL,                 -- Discord Guild ID
    channel_id         TEXT NOT NULL,                 -- Discord Channel (Forum) ID
    author_discord_id  TEXT NOT NULL,                 -- Discord User ID of the suggester
    raw_suggestion_text TEXT NOT NULL,                -- Original unstructured text from the post
    
    -- Mod identification: array of unified identifiers resolved by Aegis
    mod_identifiers    JSONB NOT NULL DEFAULT '[]'::JSONB,
    /*
     * Structure:
     * [
     *   {
     *     "curseforge_id": "123456",
     *     "modrinth_id": "abcdef",
     *     "slug": "alex-mobs",
     *     "name": "Alex's Mobs",
     *     "version": "1.20.1-2.4.3",
     *     "status": "unique" | "duplicate" | "partial_overlap",
     *     "duplicate_of_thread_id": null | "<thread_id>",
     *     "bytecode_report": null | { ... }
     *   }
     * ]
     */

    status             suggestion_status NOT NULL DEFAULT 'review',
    
    -- List of mod slugs/IDs explicitly excluded (for partial overlap batch submissions)
    exclusion_list     JSONB NOT NULL DEFAULT '[]'::JSONB,
    /*
     * Structure:
     * [
     *   {
     *     "slug": "already-added-mod",
     *     "reason": "Already active on server",
     *     "reference_thread_id": "1234567890"
     *   }
     * ]
     */

    -- Admin interaction tracking
    admin_notes        TEXT,                          -- Optimization/rejection notes from modal input
    approved_by        TEXT,                          -- Discord ID of admin who approved
    rejected_by        TEXT,                          -- Discord ID of admin who rejected
    reviewed_at        TIMESTAMPTZ,                   -- When admin action was taken

    -- Aegis diagnostic data
    bytecode_analysis  JSONB,                         -- Full bytecode profiling results
    dependency_graph   JSONB,                         -- Mod dependency tree
    resource_estimate  JSONB,                         -- CPU/Memory/Storage overhead estimates
    
    -- Related maintenance job (if approved & staged)
    maintenance_job_id UUID REFERENCES maintenance_queue(job_id) ON DELETE SET NULL,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for finding threads in specific states
CREATE INDEX idx_suggestion_threads_status ON suggestion_threads (status);
CREATE INDEX idx_suggestion_threads_author ON suggestion_threads (author_discord_id);
CREATE INDEX idx_suggestion_threads_guild  ON suggestion_threads (guild_id, status);

-- GIN index for JSONB mod_identifiers queries (e.g., "find if mod slug exists in any thread")
CREATE INDEX idx_suggestion_threads_mod_ids ON suggestion_threads USING GIN (mod_identifiers jsonb_path_ops);

-- GIN index for JSONB exclusion_list queries
CREATE INDEX idx_suggestion_threads_exclusions ON suggestion_threads USING GIN (exclusion_list jsonb_path_ops);

-- ── TABLE: maintenance_queue ────────────────────────────────
-- Tracks deployment jobs from approval through production deployment

CREATE TABLE maintenance_queue (
    job_id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Target server
    pterodactyl_server_id TEXT NOT NULL,              -- Pterodactyl server UUID
    
    -- Staging information
    target_files       JSONB NOT NULL DEFAULT '[]'::JSONB,
    /*
     * Structure:
     * [
     *   {
     *     "staging_path": "/workspace/staging/mods/alex-mobs-2.4.3.jar",
     *     "production_path": "/home/container/mods/alex-mobs-2.4.3.jar",
     *     "file_type": "mod_jar" | "config" | "script" | "other",
     *     "source_suggestion_thread_id": "1234567890",
     *     "admin_override_config": null | { ... }  -- e.g., {"disable_biomes": true}
     *   }
     * ]
     */

    -- Admin overrides
    admin_override_notes TEXT,                        -- Free-form instructions from approval modal
    approved_by        TEXT NOT NULL,                 -- Discord ID of admin who triggered deployment

    -- Execution tracking
    status             maintenance_job_status NOT NULL DEFAULT 'pending',
    execution_timestamp TIMESTAMPTZ,                  -- When the deployment actually began
    
    -- Step-by-step execution log
    execution_log      JSONB NOT NULL DEFAULT '[]'::JSONB,
    /*
     * Structure:
     * [
     *   {
     *     "step": "backup_create",
     *     "started_at": "2025-01-15T03:00:00Z",
     *     "completed_at": "2025-01-15T03:00:45Z",
     *     "status": "success" | "failed",
     *     "details": "Backup uuid-abc created successfully",
     *     "error": null | "Connection timeout"
     *   }
     * ]
     */

    -- Backup reference (for rollback)
    backup_uuid        TEXT,                          -- Pterodactyl backup UUID created pre-deployment
    
    -- Player count at execution time
    player_count_at_execution INTEGER,

    -- Health validation
    tps_at_completion  NUMERIC(5,2),                  -- TPS reading after deployment (target: 20.00)
    health_check_passed BOOLEAN DEFAULT FALSE,

    -- Cron scheduling
    scheduled_for      TIMESTAMPTZ,                   -- Earliest execution time (null = ASAP when players=0)
    cron_expression    TEXT,                           -- Optional recurring schedule

    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for finding jobs ready to execute (status = ready, players = 0)
CREATE INDEX idx_maintenance_queue_status ON maintenance_queue (status)
    WHERE status IN ('pending', 'staging', 'ready');

-- Index for scheduled job lookups
CREATE INDEX idx_maintenance_queue_scheduled ON maintenance_queue (scheduled_for)
    WHERE status = 'ready';

-- Index for tracking active executions
CREATE INDEX idx_maintenance_queue_executing ON maintenance_queue (status, execution_timestamp)
    WHERE status = 'executing';

-- GIN index for target_files JSONB queries
CREATE INDEX idx_maintenance_queue_target_files ON maintenance_queue USING GIN (target_files jsonb_path_ops);

-- ── TABLE: deployment_audit ─────────────────────────────────
-- Append-only log of every deployment action for forensic analysis

CREATE TABLE deployment_audit (
    audit_id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id             UUID NOT NULL REFERENCES maintenance_queue(job_id) ON DELETE CASCADE,
    step               deployment_step NOT NULL,
    step_order         INTEGER NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('started', 'success', 'failed', 'skipped', 'rolled_back')),
    details            TEXT,
    error_message      TEXT,
    pterodactyl_response JSONB,                      -- Raw API response for debugging
    started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at       TIMESTAMPTZ,

    CONSTRAINT chk_step_order_positive CHECK (step_order > 0)
);

CREATE INDEX idx_deployment_audit_job    ON deployment_audit (job_id, step_order);
CREATE INDEX idx_deployment_audit_status ON deployment_audit (status)
    WHERE status = 'failed';

-- ── TABLE: rate_limit_events ────────────────────────────────
-- Tracks individual 429 / rate-limit events for analytics and key rotation tuning

CREATE TABLE rate_limit_events (
    event_id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key_id             UUID NOT NULL REFERENCES api_keys(key_id) ON DELETE CASCADE,
    provider           key_provider NOT NULL,
    http_status        INTEGER NOT NULL DEFAULT 429,
    retry_after_ms     INTEGER,                       -- Value from Retry-After header
    error_body         TEXT,                          -- Raw error response body
    detected_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at        TIMESTAMPTZ                   -- When the key became usable again
);

CREATE INDEX idx_rate_limit_events_key     ON rate_limit_events (key_id, detected_at DESC);
CREATE INDEX idx_rate_limit_events_unresolved ON rate_limit_events (resolved_at)
    WHERE resolved_at IS NULL;

-- ── ENUM: ptero_credential_type ──────────────────────────────
-- Distinguishes Application API keys from Client API keys

CREATE TYPE ptero_credential_type AS ENUM (
    'application',    -- ptla_ prefix: admin-level panel access
    'client'          -- ptlc_ prefix: per-user server-scoped access
);

-- ── TABLE: ptero_credentials ────────────────────────────────
-- Dedicated Pterodactyl credential storage with AES-256-GCM encryption at rest.
-- Separated from api_keys (which stores LLM provider keys) to enforce isolation:
-- the Pterodactyl MCP server can read ptero_credentials but NOT api_keys,
-- and the inference pipeline can read api_keys but NOT ptero_credentials.

CREATE TABLE ptero_credentials (
    credential_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    credential_type   ptero_credential_type NOT NULL,

    -- AES-256-GCM encrypted token storage
    -- ptla_ keys: Application API key, full panel access, no per-server scope
    -- ptlc_ keys: Client API key, user-scoped, limited to server_scope set
    encrypted_token   TEXT NOT NULL,                -- AES-256-GCM ciphertext (base64)
    token_nonce       TEXT NOT NULL,                -- GCM nonce (base64, 12 bytes)
    token_tag         TEXT NOT NULL,                -- GCM auth tag (base64, 16 bytes)

    -- token_hash: SHA-256 of the raw (unencrypted) token prefix
    -- Used for quick existence checks and deduplication WITHOUT decrypting.
    -- Stores hash of "ptla_" or "ptlc_" prefix + first 8 chars to detect
    -- duplicate key registrations without exposing the full key.
    token_hash        TEXT NOT NULL,

    -- Human-readable description
    description       TEXT,                         -- e.g., "Client Key - Survival Server - Admin"

    -- Scoping and permissions (JSONB for flexibility)
    -- For 'client' keys: server_scope lists server UUIDs this key can access
    --   permissions lists subuser permission bits
    -- For 'application' keys: server_scope is NULL (accesses ALL servers)
    --   permissions lists Application API permission bits
    server_scope      JSONB NOT NULL DEFAULT '[]'::JSONB,
    /*
     * Structure (client keys):
     * ["uuid-server-1", "uuid-server-2"]
     *
     * Structure (application keys):
     * []  -- empty; Application keys have no per-server scope by design
     */

    permissions       JSONB NOT NULL DEFAULT '{}'::JSONB,
    /*
     * Structure (client keys):
     * {
     *   "control.console": true,
     *   "control.start": true,
     *   "file.read": true,
     *   "file.write": true,
     *   "backup.create": true,
     *   "backup.read": true,
     *   "backup.restore": false,
     *   "schedule.read": true,
     *   "websocket.connect": true
     * }
     *
     * Structure (application keys):
     * {
     *   "servers": "read",
     *   "nodes": "read",
     *   "allocations": "read",
     *   "users": "read"
     * }
     */

    -- Operational state
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,

    -- Rate limit tracking (updated by MCP server from X-RateLimit-* headers)
    rate_limit_remaining INTEGER DEFAULT 240,       -- Remaining requests in current window
    rate_limit_reset_at  TIMESTAMPTZ,               -- When rate limit window resets

    -- Audit and lifecycle
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- ── CONSTRAINTS ──────────────────────────────────────────

    -- Encrypted token must be non-empty base64
    CONSTRAINT chk_encrypted_token_not_empty CHECK (length(encrypted_token) > 0),

    -- Token hash must be non-empty (SHA-256 hex)
    CONSTRAINT chk_token_hash_not_empty CHECK (length(token_hash) > 0),

    -- Rate limit remaining cannot be negative
    CONSTRAINT chk_rate_limit_non_negative CHECK (rate_limit_remaining >= 0),

    -- Inactive keys are preserved for audit history; they must never be deleted.
    -- This constraint is enforced at the application layer, but a comment
    -- documents the policy: once a credential_id exists, it should only be
    -- soft-deleted (is_active = false), never hard-deleted via DELETE.

    -- token_hash must be unique to prevent duplicate key registration
    CONSTRAINT uq_token_hash UNIQUE (token_hash)
);

-- ── INDEXES: ptero_credentials ──────────────────────────────

-- Primary lookup: find active, non-rate-limited keys by type
CREATE INDEX idx_ptero_credentials_type_active
    ON ptero_credentials (credential_type, is_active)
    WHERE is_active = TRUE;

-- Rate limit recovery: find keys whose rate limit has expired
CREATE INDEX idx_ptero_credentials_rate_limit_reset
    ON ptero_credentials (rate_limit_reset_at)
    WHERE is_active = TRUE AND rate_limit_reset_at IS NOT NULL;

-- Server scope queries: find client keys that can access a specific server
-- Uses GIN index on JSONB array for containment queries
CREATE INDEX idx_ptero_credentials_server_scope
    ON ptero_credentials USING GIN (server_scope jsonb_path_ops)
    WHERE credential_type = 'client';

-- Permissions queries: find keys with specific permission bits
CREATE INDEX idx_ptero_credentials_permissions
    ON ptero_credentials USING GIN (permissions jsonb_path_ops);

-- Audit: find all credentials (including inactive) by type for rotation review
CREATE INDEX idx_ptero_credentials_type_all
    ON ptero_credentials (credential_type, created_at DESC);

-- ── CREDENTIAL STORAGE DOCUMENTATION ─────────────────────────
--
-- How ptla_ (Application) keys are stored:
--   1. Raw key string (e.g., "ptla_abc123def456...") is received from admin
--   2. Application layer generates random 12-byte nonce for GCM
--   3. AES-256-GCM encrypts the raw key using the master encryption key
--      from ENCRYPTION_KEY environment variable (32-byte hex)
--   4. ciphertext → base64 → encrypted_token column
--   5. nonce → base64 → token_nonce column
--   6. auth_tag → base64 → token_tag column
--   7. SHA-256 of ("ptla_" + first 8 chars of key) → token_hash column
--   8. credential_type = 'application'
--   9. server_scope = '[]' (empty — Application keys have no server scope)
--  10. permissions = {"servers": "read", ...} (coarse-grained Application permissions)
--
-- How ptlc_ (Client) keys are stored:
--   1. Raw key string (e.g., "ptlc_xyz789ghi012...") is received from admin
--   2. Same AES-256-GCM encryption process as ptla_
--   3. credential_type = 'client'
--   4. server_scope = ["uuid-of-server-1", "uuid-of-server-2"] (explicit list)
--   5. permissions = {"control.console": true, "file.read": true, ...} (granular)
--
-- AES-256-GCM Encryption Process:
--   Algorithm: AES-256-GCM (Galois/Counter Mode)
--   Key: 256-bit key from ENCRYPTION_KEY env var (32 bytes, hex-encoded)
--   Nonce: 12 bytes, cryptographically random, per-encryption
--   Tag: 16 bytes authentication tag (verified on decryption)
--   The nonce and tag are stored alongside the ciphertext so that
--   decryption can verify integrity before returning the plaintext key.
--   If the tag verification fails, the decryption is rejected — this
--   detects any tampering with the encrypted_token column.
--
-- Key Rotation Process:
--   1. Admin INSERTs new key into ptero_credentials (is_active = TRUE)
--   2. Admin signals MCP server to reload (SIGUSR1 or NATS message)
--   3. MCP server loads the new key; marks it in its in-memory cache
--   4. Admin verifies the new key works via test MCP tool invocation
--   5. Admin UPDATEs old key: SET is_active = FALSE
--   6. MCP server stops using the old key immediately on next reload
--   7. Old key row is NEVER deleted — it remains for audit history
--
-- Inactive Key Preservation for Audit:
--   When is_active = FALSE:
--   - The key is excluded from all active key selection queries
--   - The encrypted_token, token_nonce, and token_tag are RETAINED
--   - Rate limit tracking columns are no longer updated
--   - The row remains queryable for audit and forensic purposes
--   - The audit_log trigger captures the is_active change
--   - Hard deletion is prevented by application-layer policy
--     (no DELETE grant on ptero_credentials for any role)

-- ── TABLE: skill_registry ───────────────────────────────────
-- Tracks dynamically generated Aegis skill scripts

CREATE TABLE skill_registry (
    skill_id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name               TEXT NOT NULL UNIQUE,
    description        TEXT NOT NULL,
    language           TEXT NOT NULL CHECK (language IN ('python', 'javascript', 'bash', 'java')),
    file_path          TEXT NOT NULL,                  -- Relative path from aegis/skills/
    version            TEXT NOT NULL DEFAULT '1.0.0',
    parameters         JSONB NOT NULL DEFAULT '[]'::JSONB,
    /*
     * Structure:
     * [
     *   {"name": "jar_path", "type": "string", "required": true},
     *   {"name": "output_format", "type": "string", "required": false, "default": "json"}
     * ]
     */
    author             TEXT NOT NULL DEFAULT 'aegis',  -- 'aegis' for auto-generated, or admin name
    invocation_count   INTEGER NOT NULL DEFAULT 0,
    last_invoked_at    TIMESTAMPTZ,
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_skill_registry_name    ON skill_registry (name);
CREATE INDEX idx_skill_registry_language ON skill_registry (language);
CREATE INDEX idx_skill_registry_active  ON skill_registry (is_active)
    WHERE is_active = TRUE;

-- ── TABLE: cron_jobs ────────────────────────────────────────
-- Manages scheduled tasks (player monitoring, cleanup, etc.)

CREATE TABLE cron_jobs (
    job_id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name               TEXT NOT NULL UNIQUE,
    description        TEXT,
    cron_expression    TEXT NOT NULL,                  -- Standard cron expression
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    last_run_at        TIMESTAMPTZ,
    next_run_at        TIMESTAMPTZ,
    failure_count      INTEGER NOT NULL DEFAULT 0,
    max_failures       INTEGER NOT NULL DEFAULT 3,     -- Auto-disable after N consecutive failures
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── TRIGGER: updated_at auto-maintenance ────────────────────
-- Automatically update updated_at on row modification

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_api_keys_updated_at
    BEFORE UPDATE ON api_keys
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_suggestion_threads_updated_at
    BEFORE UPDATE ON suggestion_threads
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_maintenance_queue_updated_at
    BEFORE UPDATE ON maintenance_queue
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_skill_registry_updated_at
    BEFORE UPDATE ON skill_registry
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_cron_jobs_updated_at
    BEFORE UPDATE ON cron_jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_ptero_credentials_updated_at
    BEFORE UPDATE ON ptero_credentials
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── TRIGGER: audit_log auto-population ──────────────────────
-- Automatically log changes to critical tables

CREATE OR REPLACE FUNCTION log_audit_trail()
RETURNS TRIGGER AS $$
DECLARE
    audit_action TEXT;
    old_val JSONB;
    new_val JSONB;
BEGIN
    IF TG_OP = 'INSERT' THEN
        audit_action := 'INSERT';
        old_val := NULL;
        new_val := to_jsonb(NEW);
    ELSIF TG_OP = 'UPDATE' THEN
        audit_action := 'UPDATE';
        old_val := to_jsonb(OLD);
        new_val := to_jsonb(NEW);
    ELSIF TG_OP = 'DELETE' THEN
        audit_action := 'DELETE';
        old_val := to_jsonb(OLD);
        new_val := NULL;
    END IF;

    INSERT INTO audit_log (table_name, record_id, action, old_values, new_values)
    VALUES (
        TG_TABLE_NAME,
        COALESCE(NEW.key_id, NEW.thread_id::UUID, NEW.job_id, NEW.skill_id, NEW.credential_id, OLD.key_id, (OLD.thread_id)::UUID, OLD.job_id, OLD.skill_id, OLD.credential_id),
        audit_action,
        old_val,
        new_val
    );

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_api_keys_audit
    AFTER INSERT OR UPDATE OR DELETE ON api_keys
    FOR EACH ROW EXECUTE FUNCTION log_audit_trail();

CREATE TRIGGER trg_suggestion_threads_audit
    AFTER INSERT OR UPDATE OR DELETE ON suggestion_threads
    FOR EACH ROW EXECUTE FUNCTION log_audit_trail();

CREATE TRIGGER trg_maintenance_queue_audit
    AFTER INSERT OR UPDATE OR DELETE ON maintenance_queue
    FOR EACH ROW EXECUTE FUNCTION log_audit_trail();

CREATE TRIGGER trg_ptero_credentials_audit
    AFTER INSERT OR UPDATE OR DELETE ON ptero_credentials
    FOR EACH ROW EXECUTE FUNCTION log_audit_trail();

-- ── FUNCTION: reset_daily_quotas() ──────────────────────────
-- Called by cron at midnight UTC to reset token usage counters

CREATE OR REPLACE FUNCTION reset_daily_quotas()
RETURNS void AS $$
BEGIN
    UPDATE api_keys
    SET tokens_used = 0,
        is_rate_limited = FALSE,
        rate_limit_reset_at = NULL,
        updated_at = NOW()
    WHERE is_active = TRUE;
END;
$$ LANGUAGE plpgsql;

-- ── FUNCTION: get_next_valid_key(provider) ──────────────────
-- Atomic round-robin key selection for the load balancer
-- Returns the key_id with the lowest tokens_used that is active and not rate-limited

CREATE OR REPLACE FUNCTION get_next_valid_key(
    target_provider key_provider
)
RETURNS UUID AS $$
DECLARE
    selected_key_id UUID;
BEGIN
    -- Select the active, non-rate-limited key with the lowest usage for this provider
    -- "FOR UPDATE SKIP LOCKED" ensures atomic, concurrent-safe selection
    SELECT key_id INTO selected_key_id
    FROM api_keys
    WHERE provider = target_provider
      AND is_active = TRUE
      AND is_rate_limited = FALSE
      AND (rate_limit_reset_at IS NULL OR rate_limit_reset_at <= NOW())
    ORDER BY tokens_used ASC, last_used_at ASC NULLS FIRST
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    -- Update last_used_at to implement round-robin ordering
    IF selected_key_id IS NOT NULL THEN
        UPDATE api_keys
        SET last_used_at = NOW()
        WHERE key_id = selected_key_id;
    END IF;

    RETURN selected_key_id;
END;
$$ LANGUAGE plpgsql;

-- ── FUNCTION: flag_rate_limited_key(key_id, retry_after_ms) ─
-- Marks a key as rate-limited after a 429 response

CREATE OR REPLACE FUNCTION flag_rate_limited_key(
    target_key_id UUID,
    retry_after_ms INTEGER DEFAULT 60000
)
RETURNS void AS $$
BEGIN
    UPDATE api_keys
    SET is_rate_limited = TRUE,
        rate_limit_reset_at = NOW() + (retry_after_ms || ' milliseconds')::INTERVAL,
        updated_at = NOW()
    WHERE key_id = target_key_id;

    -- Log the rate limit event
    INSERT INTO rate_limit_events (key_id, provider, http_status, retry_after_ms)
    SELECT target_key_id, provider, 429, retry_after_ms
    FROM api_keys
    WHERE key_id = target_key_id;
END;
$$ LANGUAGE plpgsql;

-- ── FUNCTION: increment_token_usage(key_id, count) ──────────
-- Atomically increment token usage counter for a key

CREATE OR REPLACE FUNCTION increment_token_usage(
    target_key_id UUID,
    token_count INTEGER DEFAULT 1
)
RETURNS void AS $$
BEGIN
    UPDATE api_keys
    SET tokens_used = tokens_used + token_count,
        updated_at = NOW()
    WHERE key_id = target_key_id
      AND tokens_used + token_count <= daily_token_quota;
END;
$$ LANGUAGE plpgsql;

-- ── VIEW: active_suggestion_summary ─────────────────────────
-- Convenience view for admin dashboards

CREATE VIEW active_suggestion_summary AS
SELECT
    st.thread_id,
    st.author_discord_id,
    st.status,
    st.created_at,
    jsonb_array_length(st.mod_identifiers) AS mod_count,
    (SELECT COUNT(*) FROM jsonb_array_elements(st.mod_identifiers) AS mod
     WHERE mod->>'status' = 'duplicate') AS duplicate_count,
    (SELECT COUNT(*) FROM jsonb_array_elements(st.mod_identifiers) AS mod
     WHERE mod->>'status' = 'unique') AS unique_count,
    st.approved_by,
    st.reviewed_at
FROM suggestion_threads st
WHERE st.status IN ('review', 'staged');

-- ── VIEW: deployment_pipeline_status ────────────────────────
-- Convenience view for tracking deployment pipeline

CREATE VIEW deployment_pipeline_status AS
SELECT
    mq.job_id,
    mq.status,
    mq.approved_by,
    mq.execution_timestamp,
    jsonb_array_length(mq.target_files) AS file_count,
    mq.tps_at_completion,
    mq.health_check_passed,
    mq.backup_uuid,
    st.thread_id AS suggestion_thread_id
FROM maintenance_queue mq
LEFT JOIN suggestion_threads st ON st.maintenance_job_id = mq.job_id
WHERE mq.status NOT IN ('completed', 'rolled_back')
ORDER BY mq.created_at ASC;

-- ── GRANTS ──────────────────────────────────────────────────
-- Role-based access control for application users

-- Aegis role: full read/write on operational tables
CREATE ROLE aegis_app LOGIN;
GRANT SELECT, INSERT, UPDATE ON api_keys TO aegis_app;
GRANT SELECT, INSERT, UPDATE ON suggestion_threads TO aegis_app;
GRANT SELECT, INSERT, UPDATE ON maintenance_queue TO aegis_app;
GRANT SELECT, INSERT ON deployment_audit TO aegis_app;
GRANT SELECT, INSERT ON rate_limit_events TO aegis_app;
GRANT SELECT, INSERT, UPDATE ON skill_registry TO aegis_app;
GRANT SELECT, INSERT, UPDATE ON cron_jobs TO aegis_app;
GRANT SELECT ON audit_log TO aegis_app;
-- Aegis does NOT have direct access to ptero_credentials;
-- Pterodactyl MCP server manages Pterodactyl credentials exclusively
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO aegis_app;

-- Vanguard role: read-only on operational tables, write on audit
CREATE ROLE vanguard_app LOGIN;
GRANT SELECT ON api_keys TO vanguard_app;
GRANT SELECT, INSERT, UPDATE ON suggestion_threads TO vanguard_app;
GRANT SELECT ON maintenance_queue TO vanguard_app;
GRANT SELECT ON deployment_audit TO vanguard_app;
GRANT SELECT ON rate_limit_events TO vanguard_app;
GRANT SELECT ON skill_registry TO vanguard_app;
GRANT SELECT ON cron_jobs TO vanguard_app;
GRANT SELECT, INSERT ON audit_log TO vanguard_app;
-- Vanguard does NOT access ptero_credentials at all
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO vanguard_app;

-- Pterodactyl MCP Server role: read/write on ptero_credentials only
CREATE ROLE ptero_mcp_app LOGIN;
GRANT SELECT, INSERT, UPDATE ON ptero_credentials TO ptero_mcp_app;
-- No DELETE grant — inactive keys are preserved for audit
GRANT SELECT ON audit_log TO ptero_mcp_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ptero_mcp_app;

-- ── MIGRATION NOTES ────────────────────────────────────────
-- 1. Run `reset_daily_quotas()` via pg_cron or external scheduler at 00:00 UTC daily
-- 2. Encrypt API tokens at the application layer using AES-256-GCM before INSERT
--    This applies to BOTH `api_keys.encrypted_token` and `ptero_credentials.encrypted_token`
-- 3. The `FOR UPDATE SKIP LOCKED` pattern in get_next_valid_key() requires
--    PostgreSQL 9.5+ and ensures safe concurrent access from multiple Aegis instances
-- 4. JSONB columns use `jsonb_path_ops` GIN indexes for containment queries (@> operator)
-- 5. The audit_log trigger uses best-effort UUID casting; for tables with TEXT PKs,
--    the audit record_id may be NULL — consider adding a dedicated UUID PK column
-- 6. The `ptero_credentials` table uses a dedicated role `ptero_mcp_app` with no DELETE
--    grant, enforcing the policy that inactive keys are retained for audit history
-- 7. `ptero_credentials.token_hash` enables duplicate key detection without decrypting
--    tokens — a SHA-256 hash of the key prefix is compared before any decryption
