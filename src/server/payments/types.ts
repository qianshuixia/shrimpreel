export type PaymentProviderId = 'waffo' | 'dodo' | 'stripe' | 'mock'

export interface CheckoutInput {
  order: { id: string; packageId: string; credits: number; amountCents: number; currency: string }
  user: { id: string; email: string; name: string | null }
  successUrl: string
  cancelUrl: string
}

export interface CheckoutResult {
  url: string
  sessionId: string | null
}

// 各支付商 webhook 归一化后的事件；业务处理只认这个结构（见 src/server/orders.ts）
export type PaymentEvent =
  | {
      kind: 'paid'
      eventId: string
      eventType: string
      orderId: string | null
      providerOrderId: string | null
      providerPaymentId: string | null
      paidAmount: string | null
      paidCurrency: string | null
      paidAmountCents: number | null // 实收金额（含税），最小货币单位
      // 以下用于入账前的一致性核对（orders.ts checkPaidEvent）；支付商没有提供时留空，跳过对应检查
      productId?: string | null // 实际购买的支付商商品 ID（Dodo product_cart）
      packageId?: string | null // 商品元数据里的套餐 ID（Waffo productMetadata，由 waffo-setup.mjs 写入）
      discounted?: boolean // 用了支付商折扣码：实收低于标价属正常
      site?: string | null // 下单站点（checkout metadata.site），多个站共用商户号时区分别站的事件
      // 订阅扣款（首付和每次续费）带上订阅信息，入账走 subscriptions.ts
      subscription?: SubscriptionCharge | null
    }
  | {
      // 订阅状态变化（激活、到期取消、恢复、逾期、终止等），只更新订阅状态，不动积分
      kind: 'subscription'
      eventId: string
      eventType: string
      orderId: string | null // 首单号（checkout metadata.orderId）
      providerSubscriptionId: string
      status: SubscriptionStatus | null // null = 事件不说明状态，只更新其他字段
      cancelAtPeriodEnd: boolean | null
      periodStart: string | null
      periodEnd: string | null
      providerCustomerId: string | null
      productId: string | null // 换套餐后的支付商商品 ID（Dodo）
      planId?: string | null // 换套餐后的套餐 ID（Waffo 商品元数据）
      occurredAt: string | null // 事件发生时间，比已应用的状态旧时丢弃（webhook 可能乱序）
      site: string | null
    }
  | {
      kind: 'refunded'
      eventId: string
      eventType: string
      orderId: string | null
      providerPaymentId: string | null
      refundId: string | null // 同一笔退款的重试保持不变，作为积分回收的幂等键
      refundAmountCents: number | null // null = 全额
      originalAmountCents: number | null // 退款事件里带的原始实收金额（与 refundAmountCents 同币种）
    }
  | { kind: 'failed'; eventId: string; eventType: string; orderId: string | null }
  | {
      // 持卡人拒付：opened 回收积分；won / closed（资金留在商户，如询单关闭、撤销）补回；lost 订单记为全额退款
      kind: 'disputed'
      eventId: string
      eventType: string
      orderId: string | null
      providerPaymentId: string | null
      disputeId: string // 同一争议的所有事件保持不变，作为积分流水的幂等键
      stage: DisputeStage
      amountCents: number | null // 支付商没有明确单位时为 null，仅用于告警展示
      reason: string | null
    }
  | {
      // 发卡行欺诈预警（Stripe radar.early_fraud_warning）：还没有拒付，主动全额退款可以避免之后的拒付
      kind: 'fraud_warning'
      eventId: string
      eventType: string
      orderId: string | null
      providerPaymentId: string | null
    }
  | { kind: 'ignored'; eventId: string; eventType: string }

// 向支付商发起退款。只负责“提交”，积分回收与订单状态以之后的退款 webhook 为准（幂等）。
export interface RefundRequest {
  orderId: string
  packageId: string
  providerPaymentId: string
  amountCents: number // 本次退款金额（最小货币单位），已由调用方校验 ≤ 剩余可退
  fullAmount: boolean // 是否退满剩余全部金额
  currency: string
  reason: string
}

export interface RefundRequestResult {
  // 与退款 webhook 的幂等键一致的退款单号（Dodo 提交即返回；Waffo 要等 PSP 处理完才生成 REF_，此处为 null）
  refundId: string | null
  // Waffo 退款工单号 TKT_，只用于在支付商后台追踪，不能当作"仅记账"的退款单号
  ticketId?: string | null
  status: string
}

export type DisputeStage = 'opened' | 'won' | 'lost' | 'closed'

export type PaidEvent = Extract<PaymentEvent, { kind: 'paid' }>
export type DisputeEvent = Extract<PaymentEvent, { kind: 'disputed' }>
export type SubscriptionEvent = Extract<PaymentEvent, { kind: 'subscription' }>

export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'expired'

export interface SubscriptionCharge {
  providerSubscriptionId: string
  providerCustomerId?: string | null
  // 这次扣款覆盖的周期；支付商没给时按付款时间加计费周期推算
  periodStart?: string | null
  periodEnd?: string | null
}

export interface SubscriptionRef {
  providerSubscriptionId: string
  providerCustomerId: string | null
  user: { id: string; email: string }
}

// 主动查单（webhook 丢失或延迟时补救，见 src/server/reconcile.ts）需要的订单字段
export interface ReconcileOrder {
  id: string
  packageId: string
  providerSessionId: string | null
}

export interface PaidLookup {
  event: PaidEvent
  raw: unknown // 支付商原始响应，存进 payment_events.payload 备查
}

export interface PaymentProvider {
  id: PaymentProviderId
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>
  refund?(input: RefundRequest): Promise<RefundRequestResult>
  // 向支付商查这笔订单是否已付款成功；只在支付商明确返回成功时给出 paid 事件，其他情况（未付、失败、处理中）返回 null。
  // 失败不落库：收银台里换卡重试仍可能成功，订单保持 pending，交给 webhook 或 24 小时超时取消
  fetchPaidEvent?(order: ReconcileOrder): Promise<PaidLookup | null>
  // 到期取消（当期结束后不再续费）与撤销取消。成功后本地先更新状态，之后的状态 webhook 以支付商为准
  cancelSubscription?(subscription: SubscriptionRef): Promise<void>
  resumeSubscription?(subscription: SubscriptionRef): Promise<void>
  // 支付商托管的客户门户（换卡、发票、取消），返回跳转地址
  portalUrl?(subscription: SubscriptionRef, returnUrl: string): Promise<string>
}

export class WebhookVerificationError extends Error {}
