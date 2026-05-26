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
CREATE INDEX `share_tokens_doc_idx` ON `share_tokens` (`doc_id`);
