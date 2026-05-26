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
CREATE INDEX `document_versions_doc_idx` ON `document_versions` (`doc_id`,`created_at`);
