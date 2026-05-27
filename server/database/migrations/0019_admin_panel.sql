ALTER TABLE `users` ADD `last_login_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `is_admin` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `disabled_at` integer;--> statement-breakpoint
CREATE TABLE `ai_usage_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer REFERENCES `users`(`id`) ON DELETE set null,
	`model` text NOT NULL,
	`operation` text NOT NULL,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE INDEX `ai_usage_logs_user_idx` ON `ai_usage_logs` (`user_id`);--> statement-breakpoint
CREATE INDEX `ai_usage_logs_created_idx` ON `ai_usage_logs` (`created_at`);--> statement-breakpoint
UPDATE `users` SET `is_admin` = 1 WHERE `email` = 'dot@debian.pm';
