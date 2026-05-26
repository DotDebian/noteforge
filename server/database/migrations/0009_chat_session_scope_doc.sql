-- Sprint 4 / F11: add `scope_doc_id` to `chat_sessions` with
-- `ON DELETE SET NULL` so deleting a doc gracefully demotes its sessions to
-- workspace scope. SQLite's `ALTER TABLE ADD COLUMN` doesn't allow
-- `REFERENCES … ON DELETE SET NULL` (the FK action would need to be
-- NO ACTION), so we do the standard rebuild dance.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`scope_folder_id` integer,
	`scope_doc_id` integer,
	`title` text DEFAULT 'New chat' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scope_doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_chat_sessions` (`id`, `user_id`, `workspace_id`, `scope_folder_id`, `scope_doc_id`, `title`, `created_at`)
	SELECT `id`, `user_id`, `workspace_id`, `scope_folder_id`, NULL, `title`, `created_at` FROM `chat_sessions`;--> statement-breakpoint
DROP TABLE `chat_sessions`;--> statement-breakpoint
ALTER TABLE `__new_chat_sessions` RENAME TO `chat_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
