CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`doc_id` integer,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_by` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_workspace_idx` ON `attachments` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `attachments_sha256_idx` ON `attachments` (`sha256`);--> statement-breakpoint
CREATE TABLE `doc_links` (
	`source_doc_id` integer NOT NULL,
	`target_doc_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`source_doc_id`, `target_doc_id`),
	FOREIGN KEY (`source_doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `doc_links_target_idx` ON `doc_links` (`target_doc_id`);--> statement-breakpoint
CREATE TABLE `document_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doc_id` integer NOT NULL,
	`markdown` text NOT NULL,
	`content_json` text DEFAULT '{}' NOT NULL,
	`title` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_by` integer NOT NULL,
	`reason` text NOT NULL,
	FOREIGN KEY (`doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `document_versions_doc_idx` ON `document_versions` (`doc_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `favorites` (
	`user_id` integer NOT NULL,
	`doc_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`user_id`, `doc_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `favorites_user_idx` ON `favorites` (`user_id`);--> statement-breakpoint
CREATE TABLE `share_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`doc_id` integer NOT NULL,
	`created_by` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_tokens_doc_idx` ON `share_tokens` (`doc_id`);--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `scope_doc_id` integer REFERENCES documents(id);--> statement-breakpoint
ALTER TABLE `doc_analyses` ADD `markdown_length_at_analysis` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `doc_chunks` ADD `embedding_blob` blob;--> statement-breakpoint
ALTER TABLE `doc_chunks` ADD `section_path` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `folders` ADD `deleted_at` integer;