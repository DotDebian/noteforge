CREATE VIRTUAL TABLE `doc_chunks_fts` USING fts5(
	text,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
INSERT INTO `doc_chunks_fts`(rowid, text)
	SELECT id, text FROM `doc_chunks`;
