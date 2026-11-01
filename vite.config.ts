import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 支付商 sandbox e2e（playwright.sandbox.config.ts）用这两个变量切换支付商和回跳地址，不用改 .dev.vars。只对 dev server 生效，不会进构建产物
const sandboxProvider = process.env.SANDBOX_PAYMENT_PROVIDER
const sandboxSiteUrl = process.env.SANDBOX_SITE_URL

// 站点上线后 wrangler.jsonc 的 vars 是生产值；dev server（本地开发、e2e、CI）一律换成这组开发值，
// 否则会按 production 拦掉开发登录和 mock，e2e 的管理员也登不上。要在本地试真实服务商，写进 .dev.vars 覆盖。只影响 dev server，不进构建产物
const LOCAL_DEV_VARS = {
  APP_ENV: 'development',
  SITE_URL: 'http://localhost:3000',
  PAYMENT_PROVIDER: 'mock',
  VIDEO_PROVIDER: 'mock',
  MODERATION_PROVIDER: 'mock',
  // 本地没有 Media 绑定（只有 remote 模式）：成片输出审核走 mock，按生成请求的 mockOutcome 判定
  OUTPUT_MODERATION: 'mock',
  // 支付商一律打 test 环境：.dev.vars 放的是 test 凭据，sandbox e2e 也只能用测试卡，不能对着正式环境下单
  WAFFO_ENVIRONMENT: 'test',
  DODO_ENVIRONMENT: 'test',
  STRIPE_ENVIRONMENT: 'test',
  ADMIN_EMAILS: 'admin@example.com',
  // 本地 send_email binding 只模拟发送；站点上线前 EMAIL_FROM 可能留空，e2e 的邮件用例仍要有发件地址
  EMAIL_FROM: 'noreply@example.com',
  GOOGLE_CLIENT_ID: '',
  TURNSTILE_SITE_KEY: '',
}

export default defineConfig(({ command, mode }) => ({
  resolve: { tsconfigPaths: true },
  // .tmp 下有 Playwright HTML report，不忽略的话写报告会触发页面整页刷新，干扰正在跑的 e2e
  server: { watch: { ignored: ['**/.tmp/**'] } },
  plugins: [
    // vite build --mode staging 改用 workers.dev 预发配置；产物里的 dist/server/wrangler.json 随之切换，wrangler deploy 直接读取它
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      configPath: mode === 'staging' ? 'wrangler.staging.jsonc' : undefined,
      config:
        command === 'serve'
          ? (worker) => ({
              vars: {
                ...worker.vars,
                ...LOCAL_DEV_VARS,
                ...(sandboxProvider && sandboxSiteUrl ? { PAYMENT_PROVIDER: sandboxProvider, SITE_URL: sandboxSiteUrl } : {}),
              },
            })
          : undefined,
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
}))
