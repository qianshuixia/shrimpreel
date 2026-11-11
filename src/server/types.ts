export type UserRole = 'user' | 'admin'
export type UserStatus = 'active' | 'banned' | 'deleted'

export interface UserRow {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
  google_sub: string | null
  role: UserRole
  status: UserStatus
  credits: number
  locale: string | null
  country: string | null
  signup_source: string | null
  signup_medium: string | null
  signup_campaign: string | null
  signup_device: string | null
  attribution: string | null // JSON：first/last touch
  created_at: string
  last_login_at: string | null
}

export interface OrderRow {
  id: string
  user_id: string
  provider: string
  package_id: string
  credits: number
  amount_cents: number
  currency: string
  status: 'pending' | 'paid' | 'refunded' | 'failed' | 'canceled'
  provider_session_id: string | null
  provider_order_id: string | null
  provider_payment_id: string | null
  paid_amount: string | null
  paid_currency: string | null
  paid_amount_cents: number | null // 实收（最小单位，paid_currency）
  refunded_amount_cents: number
  refunded_credits: number
  source: string | null
  medium: string | null
  campaign: string | null
  country: string | null
  device: string | null
  attribution: string | null
  created_at: string
  paid_at: string | null
  refunded_at: string | null
  updated_at: string
  last_reconciled_at: string | null
  subscription_id: string | null // 订阅扣款订单所属的订阅
  dispute_id: string | null // 最近一次争议（拒付）的支付商编号
  dispute_status: 'open' | 'won' | 'lost' | null
  dispute_credits: number // 争议开启时实际回收的积分（已计入 refunded_credits）
  disputed_at: string | null
}

export interface SubscriptionRow {
  id: string
  user_id: string
  provider: string
  provider_subscription_id: string
  provider_customer_id: string | null
  plan_id: string
  interval: 'month' | 'year'
  credits_per_month: number
  amount_cents: number
  currency: string
  status: 'active' | 'past_due' | 'canceled' | 'expired'
  cancel_at_period_end: number
  current_period_start: string | null
  current_period_end: string | null
  current_order_id: string | null
  grants_done: number
  next_grant_at: string | null
  state_at: string | null
  created_at: string
  updated_at: string
  ended_at: string | null
}

export interface GenerationRow {
  id: string
  user_id: string
  template_id: string
  duration_id: string
  duration_seconds: number
  credits_cost: number
  upload_id: string
  second_upload_id: string | null
  status: 'queued' | 'processing' | 'succeeded' | 'failed'
  provider: string
  provider_request_id: string | null
  provider_meta: string | null
  output_r2_key: string | null
  error_code: string | null
  error_message: string | null
  attempts: number
  refunded: number
  provider_cost_cents: number | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  updated_at: string
  expired_at: string | null
  removed_at: string | null
  share_id: string | null
  share_poster_key: string | null
  shared_at: string | null
  consent_at: string | null // 生成时用户勾选同意的时间（旧数据为空）
  consent_text: string | null // 当时服务端取的同意文案原文
}

export interface UploadRow {
  id: string
  user_id: string
  r2_key: string
  content_type: string
  size_bytes: number
  sha256: string | null
  created_at: string
  expired_at: string | null
}

export interface TakedownRow {
  id: string
  reporter_name: string
  reporter_email: string
  reporter_user_id: string | null
  content_ref: string
  generation_id: string | null
  reason: 'intimate' | 'impersonation' | 'minor' | 'copyright' | 'other'
  details: string | null
  is_depicted: number
  status: 'open' | 'removed' | 'rejected'
  due_at: string
  resolved_at: string | null
  resolved_by: string | null
  resolution_note: string | null
  locale: string | null // 举报人提交时的界面语言
  reminder_stage: number // 0 未提醒，1 已提醒即将超时，2 已提醒超时
  signature: string | null // 举报人的电子签名（旧数据为空）
  created_at: string
}

export type AppContext = {
  Bindings: Env
  Variables: {
    user: UserRow | null
  }
}

export type VideoJobMessage = { kind: 'submit' | 'poll'; generationId: string }
