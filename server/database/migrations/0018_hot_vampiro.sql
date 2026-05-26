ALTER TABLE `mcp_tokens` ADD `wrapped_dek` blob;--> statement-breakpoint
ALTER TABLE `users` ADD `kdf_salt` blob;--> statement-breakpoint
ALTER TABLE `users` ADD `wrapped_dek` blob;--> statement-breakpoint
ALTER TABLE `users` ADD `recovery_wrapped_dek` blob;--> statement-breakpoint
ALTER TABLE `users` ADD `recovery_key_hash` text;--> statement-breakpoint
ALTER TABLE `users` ADD `encryption_enabled` integer DEFAULT false NOT NULL;