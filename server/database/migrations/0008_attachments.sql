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
CREATE INDEX `attachments_workspace_idx` ON `attachments` (`workspace_id`);
--> statement-breakpoint
CREATE INDEX `attachments_sha256_idx` ON `attachments` (`sha256`);
