// 可选 secret：没写进 .dev.vars 时 `npm run cf:types` 不会生成它们，这里补上类型
interface Env {
  TURNSTILE_SECRET_KEY?: string
  OPENAI_API_KEY?: string
  YIR_API_KEY?: string
  NANOAPI_API_KEY?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  PAYMENT_NOTIFY_WEBHOOK_URL?: string
  RESEND_API_KEY?: string
  // Media Transformations 绑定（wrangler.jsonc 的 "media"）：只有 OUTPUT_MODERATION=frames 时需要，模板默认不声明
  MEDIA_TRANSFORM?: MediaBinding
}
