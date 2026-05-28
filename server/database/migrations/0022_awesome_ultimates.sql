-- Workspace sharing — E2EE for shared workspaces.
--
-- Adds the cryptographic plumbing so the owner of a workspace can grant
-- access to another user without surrendering their personal DEK.
--
-- Model:
--   - Each user gets an X25519 keypair (`public_key` clear, `wrapped_private_key`
--     wrapped under the user's DEK). The keypair is generated lazily — at
--     register for new users, at first login post-migration for existing ones.
--   - Each workspace carries `encryption_mode`:
--       'dek' (default) → content encrypted under owner's DEK (legacy / solo).
--       'wek'           → content encrypted under a per-workspace WEK.
--   - On the first share, the workspace upgrades 'dek' → 'wek': a fresh WEK
--     is generated, all workspace-scoped content (folders, documents,
--     versions, analyses, chunks) is re-encrypted DEK → WEK, and the WEK is
--     sealed for the owner + each invited user in `workspace_shares`.
--
-- See server/utils/crypto.ts (sealForPublicKey / openSealed),
-- server/utils/workspace-key.ts (resolver) and
-- server/api/workspaces/[id]/shares (share endpoints).

ALTER TABLE `users` ADD `public_key` blob;--> statement-breakpoint
ALTER TABLE `users` ADD `wrapped_private_key` blob;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `encryption_mode` text DEFAULT 'dek' NOT NULL;--> statement-breakpoint

CREATE TABLE `workspace_shares` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`role` text NOT NULL,
	`wrapped_wek` blob NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_by` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_shares_workspace_user_uniq` ON `workspace_shares` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `workspace_shares_user_idx` ON `workspace_shares` (`user_id`);--> statement-breakpoint
CREATE INDEX `workspace_shares_workspace_idx` ON `workspace_shares` (`workspace_id`);
