-- Wave 2 / N3: per-message thumbs up/down feedback
-- NULL = no feedback, 1 = thumbs up, -1 = thumbs down
ALTER TABLE `chat_messages` ADD `user_feedback` integer;
