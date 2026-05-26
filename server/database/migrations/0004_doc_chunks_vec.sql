CREATE VIRTUAL TABLE `doc_chunks_vec` USING vec0(
	chunk_id INTEGER PRIMARY KEY,
	embedding float[1024] distance_metric=cosine
);
--> statement-breakpoint
INSERT INTO `doc_chunks_vec`(chunk_id, embedding)
	SELECT id, embedding_blob FROM `doc_chunks` WHERE embedding_blob IS NOT NULL;
