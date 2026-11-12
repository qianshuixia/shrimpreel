import { expect, test, type Page } from '@playwright/test'
import { ARTICLES, LOCALE_META, articlePath, findStyle, site } from '../../src/config/site'
// 与 npm run seo:check 共用同一套规则
import { runSeoCheck } from '../../scripts/seo-check.mjs'
import type { ArticleContent } from '../../src/content/en'
import { ORIGIN, content } from './helpers'

const { en, zh } = content

async function headSnapshot(page: Page) {
  return page.evaluate(() => ({
    title: document.title,
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    canonicalCount: document.querySelectorAll('link[rel="canonical"]').length,
    description: document.querySelector('meta[name="description"]')?.getAttribute('content'),
    jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap((s) => {
      const data = JSON.parse(s.textContent ?? '{}')
      return ((data['@graph'] ?? [data]) as Array<{ '@type': string }>).map((n) => n['@type'])
    }),
  }))
}

test('SSR 输出满足 seo-check 全部 error 级规则', async ({}, testInfo) => {
  const result = await runSeoCheck({ base: ORIGIN })
  await testInfo.attach('seo-check.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
  expect(result.findings.filter((f) => f.level === 'error')).toEqual([])
  // 8 个固定公开页（含 /guides）+ 每篇文章，中英各一份
  expect(result.pages.length).toBeGreaterThanOrEqual(2 * (8 + ARTICLES.length))
})

test('中英文首页水合无报错，H1/标题与 SSR 一致', async ({ page }, testInfo) => {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' || /hydrat|did not match/i.test(message.text())) problems.push(`${message.type()}: ${message.text()}`)
  })

  for (const [path, content] of [
    ['/', en],
    ['/zh', zh],
  ] as const) {
    await page.goto(path)
    // 生成器里的登录按钮在会话加载后才出现，可作为"已水合"的信号
    await expect(page.getByTestId('generator-sign-up')).toBeVisible()
    await expect(page.locator('h1')).toHaveCount(1)
    await expect(page.locator('h1')).toHaveText(content.hero.title)
    await expect(page).toHaveTitle(content.meta.homeTitle)
    await expect(page.getByRole('heading', { level: 2, name: content.howTo.title })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: content.whatIs.title })).toBeVisible()
  }
  await testInfo.attach('home-zh', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  expect(problems).toEqual([])
})

test('客户端路由切换后 head 同步更新（canonical 不残留上一页）', async ({ page }, testInfo) => {
  const origin = `https://${site.domain}`
  await page.goto('/')
  await expect(page.getByTestId('generator-sign-up')).toBeVisible()

  // 首页 → 文章：走 SPA 导航（不整页刷新）
  await page.evaluate(() => ((window as unknown as { __spaMarker: boolean }).__spaMarker = true))
  await page.getByRole('link', { name: en.whatIs.guide }).click()
  await expect(page).toHaveURL(new RegExp(`${articlePath('trend')}$`))
  await expect(page).toHaveTitle(`${en.articles.trend.title} | ${site.brandName}`)
  const article = await headSnapshot(page)
  expect(await page.evaluate(() => (window as unknown as { __spaMarker?: boolean }).__spaMarker)).toBe(true)
  expect(article.canonicalCount).toBe(1)
  expect(article.canonical).toBe(`${origin}${articlePath('trend')}`)
  expect(article.description).toBe(en.articles.trend.description)
  expect(article.jsonLd).toEqual(expect.arrayContaining(['Article', 'BreadcrumbList']))
  // 首页的 FAQPage 不能带到文章页：文章自己有 faq 时恰好一个，没有时为零
  expect(article.jsonLd.filter((t) => t === 'FAQPage')).toHaveLength((en.articles.trend as ArticleContent).faq?.length ? 1 : 0)

  // 面包屑回首页：首页的结构化数据恢复，文章的消失
  await page.getByRole('navigation', { name: en.common.breadcrumb }).getByRole('link', { name: en.meta.breadcrumbHome }).click()
  await expect(page).toHaveTitle(en.meta.homeTitle)
  const home = await headSnapshot(page)
  expect(home.canonicalCount).toBe(1)
  expect(home.canonical).toBe(origin)
  expect(home.jsonLd).toEqual(expect.arrayContaining(['Organization', 'WebSite', 'SoftwareApplication', 'FAQPage']))
  expect(home.jsonLd).not.toContain('Article')
  await testInfo.attach('head-after-spa', { body: JSON.stringify({ article, home }, null, 2), contentType: 'application/json' })
})

test('语言链接：SSR 中可抓取，点击后保留路径、查询参数和 hash', async ({ page, request }) => {
  const path = articlePath('howTo')
  // 不执行 JS 的 HTML 里就有指向另一语言同一页面的链接
  const html = await (await request.get(`${path}?ref=e2e`)).text()
  // HTML 属性名不区分大小写，React 输出的是 hrefLang
  expect(html).toMatch(new RegExp(`<a href="/zh${path}\\?ref=e2e" hreflang="zh"`, 'i'))

  await page.goto(`${path}?ref=e2e#step-2`)
  await expect(page.getByTestId('nav-sign-in')).toBeVisible()

  // 顶部下拉：Esc 关闭
  const header = page.getByRole('banner')
  await header.getByRole('button', { name: en.nav.language }).click()
  await expect(header.getByRole('link', { name: LOCALE_META.zh.name })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(header.getByRole('link', { name: LOCALE_META.zh.name })).toHaveCount(0)

  await page.getByRole('contentinfo').getByRole('navigation', { name: en.nav.language }).getByRole('link', { name: LOCALE_META.zh.name }).click()
  await expect(page).toHaveURL(new RegExp(`/zh${path}\\?ref=e2e#step-2$`))
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.locator('h1')).toHaveText(zh.articles.howTo.title)
})

test('页脚“问问 AI”：SSR 中带 nofollow 链接，中文站用中文提问并附 llms.txt，llms.txt 可访问', async ({ page, request }) => {
  const llms = await request.get('/llms.txt')
  expect(llms.status()).toBe(200)
  expect(await llms.text()).toContain(site.brandName)

  // 不执行 JS 也能看到链接，且不传权重
  const html = await (await request.get('/zh')).text()
  expect(html).toMatch(/<a href="https:\/\/claude\.ai\/new\?q=[^"]+" target="_blank" rel="noopener nofollow"/)

  await page.goto('/zh')
  const links = page.getByTestId('ask-ai').getByRole('link')
  await expect(links).toHaveCount(5)
  const href = await page.getByRole('link', { name: zh.footer.askAiLabel('Claude') }).getAttribute('href')
  const prompt = new URL(href!).searchParams.get('q')!
  // 提问来自中文文案，带首页和 llms.txt 的绝对地址
  const origin = `https://${site.domain}`
  expect(prompt).toBe(zh.footer.askAiPrompt(origin, `${origin}/llms.txt`))
  expect(prompt).not.toBe(en.footer.askAiPrompt(origin, `${origin}/llms.txt`))
})

test('文章封面：卡片和文章顶部显示，og:image 与 Article.image 用封面，SPA 切换后不残留；没填的用默认图', async ({ page, request }, testInfo) => {
  const origin = `https://${site.domain}`
  const withCover = ARTICLES.filter((a) => a.cover)
  const without = ARTICLES.find((a) => !a.cover)
  test.skip(!withCover.length, '没有文章填 cover')
  // 每个封面文件都存在，路径写错时这里失败
  for (const article of withCover) {
    const response = await request.get(article.cover!)
    expect(response.status(), article.cover).toBe(200)
    expect(response.headers()['content-type'], article.cover).toMatch(/^image\//)
  }

  const ogImages = () => page.locator('meta[property="og:image"]').evaluateAll((els) => els.map((el) => el.getAttribute('content')))
  const articleImage = () =>
    page.locator('script[type="application/ld+json"]').evaluateAll((els) =>
      els.map((el) => JSON.parse(el.textContent ?? '{}')).find((data) => data['@type'] === 'Article')?.image,
    )
  const covered = withCover[0]!

  // SSR：og:image 只有一个，是封面
  const html = await (await request.get(`/${covered.slug}`)).text()
  expect(html.match(/property="og:image"/g)).toHaveLength(1)
  expect(html).toContain(`<meta property="og:image" content="${origin}${covered.cover}"`)
  // 宽高声明跟在 og:image 后面
  expect(html.indexOf('property="og:image:width"')).toBeGreaterThan(html.indexOf('property="og:image"'))

  await page.goto('/guides')
  const cards = page.getByRole('main').getByRole('listitem')
  await expect(cards.filter({ has: page.locator(`a[href$="/${covered.slug}"]`) }).locator('img')).toHaveAttribute('src', covered.cover!)
  if (without) await expect(cards.filter({ has: page.locator(`a[href$="/${without.slug}"]`) }).locator('img')).toHaveCount(0)
  await testInfo.attach('guides', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })

  // 列表 → 文章走 SPA 导航
  await page.getByRole('link', { name: en.articles[covered.key].title }).first().click()
  await expect(page).toHaveURL(new RegExp(`/${covered.slug}$`))
  await expect(page.locator('article img').first()).toHaveAttribute('src', covered.cover!)
  await expect.poll(ogImages).toEqual([`${origin}${covered.cover}`])
  expect(await articleImage()).toEqual([`${origin}${covered.cover}`])

  // 回到列表：og:image 恢复为站点默认图
  await page.getByRole('navigation', { name: en.common.breadcrumb }).getByRole('link', { name: en.guides.title }).click()
  await expect(page).toHaveURL(/\/guides$/)
  await expect.poll(ogImages).toEqual([`${origin}${site.ogImage}`])

  if (without) {
    await page.goto(`/${without.slug}`)
    expect(await ogImages()).toEqual([`${origin}${site.ogImage}`])
    expect(await articleImage()).toEqual([`${origin}${site.ogImage}`])
    await expect(page.locator('article > img')).toHaveCount(0)
  }
})

test('文章可选能力：绑定风格显示样片并预选风格、带 FAQ 输出 FAQPage、段落表格；没填的文章不变', async ({ page }, testInfo) => {
  const bound = ARTICLES.find((a) => a.style && findStyle(a.style) && (en.articles[a.key] as ArticleContent).faq?.length)
  const plain = ARTICLES.find((a) => !a.style && !(en.articles[a.key] as ArticleContent).faq)
  test.skip(!bound || !plain, '没有同时带 style、faq 的文章，或没有对照文章')
  const style = findStyle(bound!.style!)!
  const videos = 1 + style.examples.aiVersions.length
  const jsonLdTypes = () =>
    page.locator('script[type="application/ld+json"]').evaluateAll((els) => els.map((el) => JSON.parse(el.textContent ?? '{}') as { '@type': string; mainEntity?: unknown[] }))

  for (const [prefix, c] of [
    ['', en],
    ['/zh', zh],
  ] as const) {
    const faq = (c.articles[bound!.key] as ArticleContent).faq!
    await page.goto(`${prefix}${articlePath(bound!.key)}`)
    const demo = page.getByTestId('article-style-demo')
    await expect(demo.getByRole('heading', { level: 2, name: c.guides.styleDemo })).toBeVisible()
    await expect(demo.locator('video')).toHaveCount(videos)
    // 样片在导语之后、正文之前
    const order = await page.evaluate(() => {
      const intro = [...document.querySelectorAll('article > p')].find((p) => p.classList.contains('text-xl'))
      const demo = document.querySelector('[data-testid="article-style-demo"]')
      const body = document.querySelector('.prose-article')
      return !!intro && !!demo && !!body && !!(intro.compareDocumentPosition(demo) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(demo.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(order).toBe(true)
    // CTA 带 ?style= 预选风格
    const cta = page.getByRole('link', { name: c.finalCta.cta })
    await expect(cta).toHaveAttribute('href', `${prefix || '/'}?style=${style.id}#create`)
    // FAQ：标题 + 折叠项，点开可见答案
    const faqSection = page.getByTestId('article-faq')
    await expect(faqSection.getByRole('heading', { level: 2, name: c.guides.faqTitle })).toBeVisible()
    await expect(faqSection.locator('details')).toHaveCount(faq.length)
    await faqSection.getByText(faq[0]!.q).click()
    await expect(faqSection.getByText(faq[0]!.a)).toBeVisible()
    const ld = (await jsonLdTypes()).filter((n) => n['@type'] === 'FAQPage')
    expect(ld).toHaveLength(1)
    expect(ld[0]!.mainEntity).toHaveLength(faq.length)
    // 段落表格：表头、行数与 content 一致，首列是行标题
    const tables = (c.articles[bound!.key] as ArticleContent).sections.flatMap((sec) => (sec.table ? [sec.table] : []))
    await expect(page.locator('.prose-article table')).toHaveCount(tables.length)
    if (tables[0]) {
      const table = page.locator('.prose-article table').first()
      await expect(table.locator('thead th')).toHaveText(tables[0].head)
      await expect(table.locator('tbody tr')).toHaveCount(tables[0].rows.length)
      await expect(table.locator('tbody th[scope=row]').first()).toHaveText(tables[0].rows[0]![0]!)
    }
    if (prefix === '') await testInfo.attach('bound-article', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  }

  // 对照：没有 style、faq 的文章（模板示例里也没有表格）
  const plainTables = (en.articles[plain!.key] as ArticleContent).sections.filter((sec) => sec.table).length
  for (const prefix of ['', '/zh']) {
    await page.goto(`${prefix}${articlePath(plain!.key)}`)
    await expect(page.getByTestId('article-style-demo')).toHaveCount(0)
    await expect(page.getByTestId('article-faq')).toHaveCount(0)
    await expect(page.locator('article video')).toHaveCount(0)
    await expect(page.locator('.prose-article table')).toHaveCount(plainTables)
    expect((await jsonLdTypes()).map((n) => n['@type'])).not.toContain('FAQPage')
    await expect(page.getByRole('link', { name: (prefix ? zh : en).finalCta.cta })).toHaveAttribute('href', `${prefix || '/'}#create`)
  }
})
