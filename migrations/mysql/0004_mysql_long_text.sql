-- ai 0004: mysql_long_text
-- TEXT caps at 64KB on MySQL, too small for long replies and tool output.

ALTER TABLE `p_ai_messages` MODIFY COLUMN `content` longtext NOT NULL DEFAULT ('');
ALTER TABLE `p_ai_messages` MODIFY COLUMN `tool_calls` longtext;
ALTER TABLE `p_ai_proposals` MODIFY COLUMN `payload` longtext NOT NULL DEFAULT ('{}');
