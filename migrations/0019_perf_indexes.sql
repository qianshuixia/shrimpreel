-- 性能与安全索引（P0-2、P1-5、P2-2）
-- 1) Cron 每 5 分钟扫表拆弹：部分索引只覆盖尚未清理/未过期的活跃记录
CREATE INDEX IF NOT EXISTS idx_uploads_active_created
  ON uploads(created_at) WHERE expired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_generations_active_output
  ON generations(completed_at) WHERE status = 'succeeded' AND output_r2_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_generations_completed
  ON generations(completed_at) WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_generations_live_upload
  ON generations(upload_id) WHERE status IN ('queued', 'processing');

CREATE INDEX IF NOT EXISTS idx_generations_live_second_upload
  ON generations(second_upload_id) WHERE status IN ('queued', 'processing') AND second_upload_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_expires
  ON sessions(expires_at);

-- 2) 支付回调 / 对账查单、后台统计、告警、周报与邀请排行索引
CREATE INDEX IF NOT EXISTS idx_orders_provider_session
  ON orders(provider, provider_session_id) WHERE provider_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_provider_order
  ON orders(provider, provider_order_id) WHERE provider_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_paid_status
  ON orders(status, paid_at) WHERE status IN ('paid', 'refunded');

CREATE INDEX IF NOT EXISTS idx_orders_user_status
  ON orders(user_id, status);

CREATE INDEX IF NOT EXISTS idx_users_status_credits
  ON users(status, credits);

CREATE INDEX IF NOT EXISTS idx_email_outbox_alert
  ON email_outbox(created_at, template, status, attempts);

CREATE INDEX IF NOT EXISTS idx_payment_events_review
  ON payment_events(status, created_at, order_id);

CREATE INDEX IF NOT EXISTS idx_referrals_created_summary
  ON referrals(created_at, inviter_id, status, reward_credits);

-- 3) 清理已过期末尾周期但丢失终止 webhook 的订阅，随后加单用户唯一活跃订阅约束
UPDATE subscriptions
SET status = 'expired',
    ended_at = COALESCE(ended_at, current_period_end),
    next_grant_at = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status IN ('active', 'past_due')
  AND cancel_at_period_end = 1
  AND current_period_end IS NOT NULL
  AND current_period_end <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_one_live
  ON subscriptions(user_id) WHERE status IN ('active', 'past_due');
