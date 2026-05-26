CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_messages_session_idx` ON `chat_messages` (`session_id`);--> statement-breakpoint
CREATE TABLE `chat_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`scope_folder_id` integer,
	`title` text DEFAULT 'New chat' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `doc_analyses` (
	`doc_id` integer PRIMARY KEY NOT NULL,
	`summary_short` text DEFAULT '' NOT NULL,
	`summary_long` text DEFAULT '' NOT NULL,
	`use_cases` text DEFAULT '[]' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`questions` text DEFAULT '[]' NOT NULL,
	`action_items` text DEFAULT '[]' NOT NULL,
	`language` text,
	`generated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `doc_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_id` integer NOT NULL,
	`idx` integer NOT NULL,
	`text` text NOT NULL,
	`embedding` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `doc_chunks_doc_idx` ON `doc_chunks` (`doc_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `doc_chunks_doc_idx_unique` ON `doc_chunks` (`doc_id`,`idx`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`folder_id` integer,
	`title` text DEFAULT 'Untitled' NOT NULL,
	`markdown` text DEFAULT '' NOT NULL,
	`content_json` text DEFAULT '{}' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `documents_folder_idx` ON `documents` (`folder_id`);--> statement-breakpoint
CREATE INDEX `documents_workspace_idx` ON `documents` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`parent_id` integer,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `folders_parent_idx` ON `folders` (`parent_id`);--> statement-breakpoint
CREATE INDEX `folders_workspace_idx` ON `folders` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`display_name` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer NOT NULL,
	`name` text NOT NULL,
	`emoji` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
