CREATE TABLE `mcp_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tokens_token_hash_idx` ON `mcp_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `mcp_tokens_user_idx` ON `mcp_tokens` (`user_id`);