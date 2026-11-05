import { defineConfig, devices } from '@playwright/test'

// 工件统一落在 .tmp/video-template-e2e/（HTML report、trace、截图、JSON 结果）
const ARTIFACTS = '.tmp/video-template-e2e'
const PORT = process.env.E2E_PORT ?? '3000'
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: `${ARTIFACTS}/test-results`,
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // 共用一个本地 Worker + D1，串行跑结果更稳定；每个用例用独立邮箱，不互相污染
  workers: 1,
  // CI 偶发 page.goto net::ERR_ABORTED（根因未明，见 ROADMAP），重试一次并保留 trace
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${ARTIFACTS}/report`, open: 'never' }],
    ['json', { outputFile: `${ARTIFACTS}/results.json` }],
  ],
  use: {
    baseURL: BASE_URL,
    // 本地每个用例都留 trace 和截图，便于复核；CI 只留失败的，上传的报告才不会占满账号的 Actions 存储
    trace: process.env.CI ? 'retain-on-failure' : 'on',
    screenshot: process.env.CI ? 'only-on-failure' : 'on',
    locale: 'en-US',
    // 站点填了 analytics.ga4Id 时，同意横幅会挡住页面底部的按钮，接受后还会把测试访问发到真实的 GA4 媒体资源。
    // 默认按“拒绝”预置同意状态；需要同意的用例自己改（见 attribution.spec.ts）。没配 GA4 时这一项不起作用。
    storageState: {
      cookies: [],
      origins: [{ origin: BASE_URL, localStorage: [{ name: 'consent.analytics', value: 'denied' }] }],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Windows 下 vite 默认只监听 [::1]，显式绑定 IPv4
  webServer: {
    command: `npx vite dev --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
