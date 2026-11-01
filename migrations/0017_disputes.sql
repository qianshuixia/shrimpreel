-- 支付争议（拒付）：orders 上只记录最近一次处理中或已结案的争议，积分流水用幂等键 dispute:<id> / dispute_won:<id> 对账
-- dispute_status：open（积分已回收，等结果）| won（积分已补回）| lost（订单记为已退款）
ALTER TABLE orders ADD COLUMN dispute_id TEXT;
ALTER TABLE orders ADD COLUMN dispute_status TEXT CHECK (dispute_status IN ('open', 'won', 'lost'));
-- 争议开启时实际回收的积分（用户可能已花掉一部分，所以可能小于订单积分）；已计入 refunded_credits，赢了补回时再减去
ALTER TABLE orders ADD COLUMN dispute_credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN disputed_at TEXT;
CREATE INDEX idx_orders_dispute ON orders(dispute_status) WHERE dispute_status IS NOT NULL;
