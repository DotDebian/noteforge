-- Extend ai_usage_logs with success / latency / error tracking
ALTER TABLE `ai_usage_logs` ADD `success` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_usage_logs` ADD `latency_ms` integer;--> statement-breakpoint
ALTER TABLE `ai_usage_logs` ADD `error_code` text;--> statement-breakpoint

-- Login attempts (failed + successful)
CREATE TABLE `login_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`user_id` integer REFERENCES `users`(`id`) ON DELETE set null,
	`success` integer NOT NULL,
	`error_code` text,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE INDEX `login_attempts_email_idx` ON `login_attempts` (`email`);--> statement-breakpoint
CREATE INDEX `login_attempts_created_idx` ON `login_attempts` (`created_at`);--> statement-breakpoint

-- Admin audit log
CREATE TABLE `admin_audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`admin_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` integer,
	`payload` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE INDEX `admin_audit_log_admin_idx` ON `admin_audit_log` (`admin_id`);--> statement-breakpoint
CREATE INDEX `admin_audit_log_created_idx` ON `admin_audit_log` (`created_at`);--> statement-breakpoint

-- MCP call logs
CREATE TABLE `mcp_call_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_id` integer REFERENCES `mcp_tokens`(`id`) ON DELETE set null,
	`user_id` integer REFERENCES `users`(`id`) ON DELETE set null,
	`tool_name` text NOT NULL,
	`success` integer NOT NULL,
	`latency_ms` integer,
	`error_code` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE INDEX `mcp_call_logs_token_idx` ON `mcp_call_logs` (`token_id`);--> statement-breakpoint
CREATE INDEX `mcp_call_logs_user_idx` ON `mcp_call_logs` (`user_id`);--> statement-breakpoint
CREATE INDEX `mcp_call_logs_tool_idx` ON `mcp_call_logs` (`tool_name`);--> statement-breakpoint
CREATE INDEX `mcp_call_logs_created_idx` ON `mcp_call_logs` (`created_at`);--> statement-breakpoint

-- RAG quality logs
CREATE TABLE `rag_quality_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer REFERENCES `chat_sessions`(`id`) ON DELETE set null,
	`user_id` integer REFERENCES `users`(`id`) ON DELETE set null,
	`chunks_returned` integer DEFAULT 0 NOT NULL,
	`rerank_score_avg` text,
	`citations_emitted` integer DEFAULT 0 NOT NULL,
	`has_citation` integer DEFAULT 0 NOT NULL,
	`rewriter_used` integer DEFAULT 0 NOT NULL,
	`reranker_used` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE INDEX `rag_quality_logs_user_idx` ON `rag_quality_logs` (`user_id`);--> statement-breakpoint
CREATE INDEX `rag_quality_logs_created_idx` ON `rag_quality_logs` (`created_at`);--> statement-breakpoint

-- Daily health snapshots for growth charts
CREATE TABLE `health_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`db_size_bytes` integer DEFAULT 0 NOT NULL,
	`users_count` integer DEFAULT 0 NOT NULL,
	`docs_count` integer DEFAULT 0 NOT NULL,
	`chunks_count` integer DEFAULT 0 NOT NULL,
	`sessions_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE INDEX `health_snapshots_created_idx` ON `health_snapshots` (`created_at`);--> statement-breakpoint

-- Per-user quotas
CREATE TABLE `user_quotas` (
	`user_id` integer PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`max_docs` integer,
	`max_tokens_month` integer,
	`max_workspaces` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint

-- App logs (in-app viewer)
CREATE TABLE `app_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`level` text NOT NULL,
	`source` text NOT NULL,
	`message` text NOT NULL,
	`context` text,
	`user_id` integer REFERENCES `users`(`id`) ON DELETE set null,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE INDEX `app_logs_level_idx` ON `app_logs` (`level`);--> statement-breakpoint
CREATE INDEX `app_logs_created_idx` ON `app_logs` (`created_at`);--> statement-breakpoint

-- Jobs queue (visibility for fire-and-forget background work)
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload` text,
	`user_id` integer REFERENCES `users`(`id`) ON DELETE set null,
	`started_at` integer,
	`completed_at` integer,
	`duration_ms` integer,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_type_idx` ON `jobs` (`type`);--> statement-breakpoint
CREATE INDEX `jobs_created_idx` ON `jobs` (`created_at`);--> statement-breakpoint

-- Decryption failures (signals data corruption / DEK problems)
CREATE TABLE `decryption_failures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer REFERENCES `users`(`id`) ON DELETE set null,
	`entity_type` text NOT NULL,
	`entity_id` integer,
	`field` text NOT NULL,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE INDEX `decryption_failures_user_idx` ON `decryption_failures` (`user_id`);--> statement-breakpoint
CREATE INDEX `decryption_failures_created_idx` ON `decryption_failures` (`created_at`);--> statement-breakpoint

-- Retention policy (KV)
CREATE TABLE `retention_policy` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
