CREATE TABLE `doc_links` (
	`source_doc_id` integer NOT NULL,
	`target_doc_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`source_doc_id`, `target_doc_id`),
	FOREIGN KEY (`source_doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `doc_links_target_idx` ON `doc_links` (`target_doc_id`);
