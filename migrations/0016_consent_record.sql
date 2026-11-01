-- 服务端留存同意记录：生成时的同意时间和同意文案原文，举报单的电子签名
ALTER TABLE generations ADD COLUMN consent_at TEXT;
ALTER TABLE generations ADD COLUMN consent_text TEXT;
ALTER TABLE takedown_requests ADD COLUMN signature TEXT;
