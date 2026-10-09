CREATE TYPE "public"."deployment_step" AS ENUM('backup_create', 'backup_verify', 'file_swap', 'server_stop', 'server_start', 'health_check', 'tps_validation', 'changelog_publish');--> statement-breakpoint
CREATE TYPE "public"."key_provider" AS ENUM('groq', 'opencode_zen');--> statement-breakpoint
CREATE TYPE "public"."maintenance_job_status" AS ENUM('pending', 'staging', 'ready', 'executing', 'completed', 'failed', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."ptero_credential_type" AS ENUM('application', 'client');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('review', 'staged', 'deployed', 'rejected', 'archived');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"key_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "key_provider" NOT NULL,
	"encrypted_token" text NOT NULL,
	"token_nonce" text NOT NULL,
	"token_tag" text NOT NULL,
	"daily_token_quota" integer DEFAULT 100000 NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_rate_limited" boolean DEFAULT false NOT NULL,
	"rate_limit_reset_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"donor_discord_id" text,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_quota_non_negative" CHECK ("api_keys"."daily_token_quota" >= 0),
	CONSTRAINT "chk_tokens_used_non_negative" CHECK ("api_keys"."tokens_used" >= 0),
	CONSTRAINT "chk_tokens_within_quota" CHECK ("api_keys"."tokens_used" <= "api_keys"."daily_token_quota")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"audit_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_name" text NOT NULL,
	"record_id" uuid NOT NULL,
	"action" text NOT NULL,
	"changed_by" text DEFAULT 'system' NOT NULL,
	"old_values" jsonb,
	"new_values" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_audit_action" CHECK ("audit_log"."action" IN ('INSERT', 'UPDATE', 'DELETE'))
);
--> statement-breakpoint
CREATE TABLE "cron_jobs" (
	"job_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"cron_expression" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"max_failures" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cron_jobs_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "deployment_audit" (
	"audit_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"step" "deployment_step" NOT NULL,
	"step_order" integer NOT NULL,
	"status" text NOT NULL,
	"details" text,
	"error_message" text,
	"pterodactyl_response" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "chk_step_order_positive" CHECK ("deployment_audit"."step_order" > 0),
	CONSTRAINT "chk_deployment_audit_status" CHECK ("deployment_audit"."status" IN ('started', 'success', 'failed', 'skipped', 'rolled_back'))
);
--> statement-breakpoint
CREATE TABLE "maintenance_queue" (
	"job_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pterodactyl_server_id" text NOT NULL,
	"target_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"admin_override_notes" text,
	"approved_by" text NOT NULL,
	"status" "maintenance_job_status" DEFAULT 'pending' NOT NULL,
	"execution_timestamp" timestamp with time zone,
	"execution_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"backup_uuid" text,
	"player_count_at_execution" integer,
	"tps_at_completion" numeric(5, 2),
	"health_check_passed" boolean DEFAULT false,
	"scheduled_for" timestamp with time zone,
	"cron_expression" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ptero_credentials" (
	"credential_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_type" "ptero_credential_type" NOT NULL,
	"encrypted_token" text NOT NULL,
	"token_nonce" text NOT NULL,
	"token_tag" text NOT NULL,
	"token_hash" text NOT NULL,
	"description" text,
	"server_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"rate_limit_remaining" integer DEFAULT 240,
	"rate_limit_reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_encrypted_token_not_empty" CHECK (length("ptero_credentials"."encrypted_token") > 0),
	CONSTRAINT "chk_token_hash_not_empty" CHECK (length("ptero_credentials"."token_hash") > 0),
	CONSTRAINT "chk_rate_limit_non_negative" CHECK ("ptero_credentials"."rate_limit_remaining" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rate_limit_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" uuid NOT NULL,
	"provider" "key_provider" NOT NULL,
	"http_status" integer DEFAULT 429 NOT NULL,
	"retry_after_ms" integer,
	"error_body" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "skill_registry" (
	"skill_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"language" text NOT NULL,
	"file_path" text NOT NULL,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"author" text DEFAULT 'aegis' NOT NULL,
	"invocation_count" integer DEFAULT 0 NOT NULL,
	"last_invoked_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_registry_name_unique" UNIQUE("name"),
	CONSTRAINT "chk_skill_language" CHECK ("skill_registry"."language" IN ('python', 'javascript', 'bash', 'java'))
);
--> statement-breakpoint
CREATE TABLE "suggestion_threads" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"original_post_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"author_discord_id" text NOT NULL,
	"raw_suggestion_text" text NOT NULL,
	"mod_identifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "suggestion_status" DEFAULT 'review' NOT NULL,
	"exclusion_list" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"admin_notes" text,
	"approved_by" text,
	"rejected_by" text,
	"reviewed_at" timestamp with time zone,
	"bytecode_analysis" jsonb,
	"dependency_graph" jsonb,
	"resource_estimate" jsonb,
	"maintenance_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployment_audit" ADD CONSTRAINT "fk_deployment_audit_job" FOREIGN KEY ("job_id") REFERENCES "public"."maintenance_queue"("job_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_events" ADD CONSTRAINT "fk_rate_limit_events_key" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("key_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion_threads" ADD CONSTRAINT "fk_suggestion_threads_maintenance_job" FOREIGN KEY ("maintenance_job_id") REFERENCES "public"."maintenance_queue"("job_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_api_keys_provider_active" ON "api_keys" USING btree ("provider","is_active","is_rate_limited");--> statement-breakpoint
CREATE INDEX "idx_api_keys_rate_limit_reset" ON "api_keys" USING btree ("rate_limit_reset_at");--> statement-breakpoint
CREATE INDEX "idx_api_keys_provider_usage" ON "api_keys" USING btree ("provider","tokens_used");--> statement-breakpoint
CREATE INDEX "idx_audit_log_table_record" ON "audit_log" USING btree ("table_name","record_id");--> statement-breakpoint
CREATE INDEX "idx_audit_log_created_at" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_deployment_audit_job" ON "deployment_audit" USING btree ("job_id","step_order");--> statement-breakpoint
CREATE INDEX "idx_deployment_audit_status" ON "deployment_audit" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_maintenance_queue_status" ON "maintenance_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_maintenance_queue_scheduled" ON "maintenance_queue" USING btree ("scheduled_for");--> statement-breakpoint
CREATE INDEX "idx_maintenance_queue_executing" ON "maintenance_queue" USING btree ("status","execution_timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_token_hash" ON "ptero_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_ptero_credentials_type_active" ON "ptero_credentials" USING btree ("credential_type","is_active");--> statement-breakpoint
CREATE INDEX "idx_ptero_credentials_rate_limit_reset" ON "ptero_credentials" USING btree ("rate_limit_reset_at");--> statement-breakpoint
CREATE INDEX "idx_ptero_credentials_type_all" ON "ptero_credentials" USING btree ("credential_type","created_at");--> statement-breakpoint
CREATE INDEX "idx_rate_limit_events_key" ON "rate_limit_events" USING btree ("key_id","detected_at");--> statement-breakpoint
CREATE INDEX "idx_rate_limit_events_unresolved" ON "rate_limit_events" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "idx_skill_registry_name" ON "skill_registry" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_skill_registry_language" ON "skill_registry" USING btree ("language");--> statement-breakpoint
CREATE INDEX "idx_skill_registry_active" ON "skill_registry" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_suggestion_threads_status" ON "suggestion_threads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_suggestion_threads_author" ON "suggestion_threads" USING btree ("author_discord_id");--> statement-breakpoint
CREATE INDEX "idx_suggestion_threads_guild" ON "suggestion_threads" USING btree ("guild_id","status");