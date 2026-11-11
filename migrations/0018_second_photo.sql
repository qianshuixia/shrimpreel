-- 双人风格：第二张照片（第 1 张在 upload_id，源视频左边的人；这张是右边的人）。单人生成为 NULL
ALTER TABLE generations ADD COLUMN second_upload_id TEXT;
CREATE INDEX idx_generations_second_upload ON generations(second_upload_id);
