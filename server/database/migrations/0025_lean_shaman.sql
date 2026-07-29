CREATE TABLE `oauth_auth_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_row_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`code_hash` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`resource` text,
	`scope` text NOT NULL,
	`wrapped_dek` blob,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`client_row_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_auth_codes_code_hash_idx` ON `oauth_auth_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `oauth_auth_codes_expires_idx` ON `oauth_auth_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text,
	`client_id` text NOT NULL,
	`client_secret_hash` text NOT NULL,
	`secret_prefix` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_clients_client_id_idx` ON `oauth_clients` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauth_clients_user_idx` ON `oauth_clients` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_row_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`auth_code_id` integer,
	`access_token_hash` text NOT NULL,
	`refresh_token_hash` text,
	`wrapped_dek_access` blob,
	`wrapped_dek_refresh` blob,
	`scope` text NOT NULL,
	`access_expires_at` integer NOT NULL,
	`refresh_expires_at` integer,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`client_row_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`auth_code_id`) REFERENCES `oauth_auth_codes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_access_hash_idx` ON `oauth_tokens` (`access_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_refresh_hash_idx` ON `oauth_tokens` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `oauth_tokens_client_idx` ON `oauth_tokens` (`client_row_id`);--> statement-breakpoint
CREATE INDEX `oauth_tokens_user_idx` ON `oauth_tokens` (`user_id`);