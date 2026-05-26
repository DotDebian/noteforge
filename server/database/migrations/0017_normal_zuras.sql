CREATE TABLE `saved_searches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`name` text NOT NULL,
	`query_json` text DEFAULT '{}' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saved_searches_user_idx` ON `saved_searches` (`user_id`);--> statement-breakpoint
CREATE INDEX `saved_searches_workspace_idx` ON `saved_searches` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`editor` text DEFAULT '{}' NOT NULL,
	`ai` text DEFAULT '{}' NOT NULL,
	`notifications` text DEFAULT '{}' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_totp` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`secret_encrypted` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`backup_codes` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`enabled_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `parent_session_id` integer;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `branch_from_message_id` integer;