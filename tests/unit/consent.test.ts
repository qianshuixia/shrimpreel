import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONSENT_KEY, clarityBootstrapScript, ga4BootstrapScript, regionalConsentDefault, saveConsent } from '#/lib/consent'

const GA4_ID = 'G-TEST123'

// 最小浏览器环境：记录 dataLayer、追加到 <head> 的脚本和每次写 document.cookie 的内容
// regionDefault：服务端写在 <html data-consent-default> 上的地区默认值
function browser(stored: string | null | 'throws', href = 'https://example.test/checkout/result?email=buyer%40example.test&status=paid', regionDefault = 'denied') {
  const appended: Array<{ src: string }> = []
  const cookieWrites: string[] = []
  let cookie = ''
  const document = {
    documentElement: { getAttribute: (name: string) => (name === 'data-consent-default' ? regionDefault : null) },
    createElement: () => ({ async: false, src: '' }),
    head: { appendChild: (el: { src: string }) => appended.push(el) },
    querySelector: (selector: string) => appended.find((el) => selector.includes(el.src.split('?')[0]!)) ?? null,
    get cookie() {
      return cookie
    },
    set cookie(value: string) {
      cookieWrites.push(value)
    },
  }
  const localStorage = {
    getItem: () => {
      if (stored === 'throws') throw new Error('SecurityError')
      return stored
    },
    setItem: vi.fn(),
  }
  const window = { dataLayer: undefined as unknown[] | undefined, gtag: undefined as unknown }
  const context = { window, document, localStorage, location: new URL(href), URL, Date }
  return {
    context,
    appended,
    cookieWrites,
    setCookie: (value: string) => (cookie = value),
    run(script: string) {
      // 内联脚本在全局作用域执行：window 即全局对象
      const global = Object.assign(context.window, context)
      runInNewContext(script, global)
      return global as typeof global & { dataLayer: IArguments[] }
    },
  }
}

const calls = (dataLayer: IArguments[]) => dataLayer.map((args) => Array.from(args))

describe('regionalConsentDefault', () => {
  it('EEA、英国、瑞士和无法判断国家的访客默认 denied，其他地区 granted', () => {
    for (const country of ['DE', 'fr', 'IE', 'NO', 'IS', 'LI', 'GB', 'CH', 'XX', 'T1', '', null, undefined, 'EU1']) {
      expect(regionalConsentDefault(country)).toBe('denied')
    }
    for (const country of ['US', 'SG', 'CN', 'HK', 'JP', 'BR', 'ca']) expect(regionalConsentDefault(country)).toBe('granted')
  })
})

describe('ga4BootstrapScript', () => {
  it('没有选择过：分析和广告都默认 denied，不加载 gtag.js；page_location 去掉 email', () => {
    const env = browser(null)
    const global = env.run(ga4BootstrapScript(GA4_ID))
    const [consent, , config] = calls(global.dataLayer)
    expect(consent).toEqual([
      'consent',
      'default',
      { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' },
    ])
    expect(config).toEqual(['config', GA4_ID, { page_location: 'https://example.test/checkout/result?status=paid' }])
    expect(env.appended).toEqual([])
  })

  it('已同意的回访者：analytics_storage granted 并加载 gtag.js；广告项仍 denied', () => {
    const env = browser('granted')
    const global = env.run(ga4BootstrapScript(GA4_ID))
    expect(calls(global.dataLayer)[0]![2]).toMatchObject({ analytics_storage: 'granted', ad_storage: 'denied' })
    expect(env.appended.map((s) => s.src)).toEqual([`https://www.googletagmanager.com/gtag/js?id=${GA4_ID}`])
  })

  it('默认开启的地区：没选择过或禁用存储时按 granted 加载；拒绝过的仍不加载', () => {
    for (const stored of [null, 'throws'] as const) {
      const env = browser(stored, undefined, 'granted')
      const global = env.run(ga4BootstrapScript(GA4_ID))
      expect(calls(global.dataLayer)[0]![2]).toMatchObject({ analytics_storage: 'granted', ad_storage: 'denied' })
      expect(env.appended).toHaveLength(1)
    }
    const env = browser('denied', undefined, 'granted')
    expect(calls(env.run(ga4BootstrapScript(GA4_ID)).dataLayer)[0]![2]).toMatchObject({ analytics_storage: 'denied' })
    expect(env.appended).toEqual([])
  })

  it('拒绝过或禁用存储：不加载', () => {
    for (const stored of ['denied', 'throws'] as const) {
      const env = browser(stored)
      const global = env.run(ga4BootstrapScript(GA4_ID))
      expect(calls(global.dataLayer)[0]![2]).toMatchObject({ analytics_storage: 'denied' })
      expect(env.appended).toEqual([])
    }
  })
})

describe('clarityBootstrapScript', () => {
  const clarity = (href: string, stored: string | null | 'throws' = null) => {
    const env = browser(stored, href)
    const global = env.run(clarityBootstrapScript('abc123', 'example.test')) as unknown as { clarity?: { q: IArguments[] } }
    return { env, queue: (global.clarity?.q ?? []).map((args) => Array.from(args)) }
  }

  it('正式域名：先排队同意状态再加载 tag；未选择、拒绝或禁用存储时 analytics denied（无 Cookie 模式）', () => {
    for (const stored of [null, 'denied', 'throws'] as const) {
      const { env, queue } = clarity('https://www.example.test/pricing', stored)
      expect(queue).toEqual([['consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' }]])
      expect(env.appended.map((s) => s.src)).toEqual(['https://www.clarity.ms/tag/abc123'])
    }
  })

  it('已同意：analytics granted，广告仍 denied', () => {
    const { queue } = clarity('https://example.test/', 'granted')
    expect(queue).toEqual([['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }]])
  })

  it('默认开启的地区：没选择过时 granted，拒绝过的仍 denied', () => {
    const run = (stored: string | null) => {
      const env = browser(stored, 'https://example.test/', 'granted')
      const global = env.run(clarityBootstrapScript('abc123', 'example.test')) as unknown as { clarity: { q: IArguments[] } }
      return Array.from(global.clarity.q[0]!)
    }
    expect(run(null)).toEqual(['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }])
    expect(run('denied')).toEqual(['consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' }])
  })

  it('本地、staging 等其他主机和 /admin 不加载', () => {
    for (const href of ['http://localhost:3200/', 'https://staging.example.test/', 'https://example.test.evil.dev/', 'https://example.test/admin/orders']) {
      const { env, queue } = clarity(href)
      expect(queue).toEqual([])
      expect(env.appended).toEqual([])
    }
  })
})

describe('saveConsent', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stub(href: string) {
    const env = browser(null, href)
    env.run(ga4BootstrapScript(GA4_ID))
    for (const [key, value] of Object.entries(env.context)) vi.stubGlobal(key, value)
    return env
  }

  it('接受：记住选择、更新同意状态并只加载一次 gtag.js', () => {
    const env = stub('https://www.example.test/')
    saveConsent(GA4_ID, 'granted')
    saveConsent(GA4_ID, 'granted')
    expect(env.context.localStorage.setItem).toHaveBeenCalledWith(CONSENT_KEY, 'granted')
    expect(calls(env.context.window.dataLayer as IArguments[]).at(-1)).toEqual(['consent', 'update', { analytics_storage: 'granted' }])
    expect(env.appended).toHaveLength(1)
  })

  it('撤回：更新为 denied，并在当前主机和各级父域上删除 _ga 系列 Cookie，不动其他 Cookie', () => {
    const env = stub('https://www.example.test/')
    env.setCookie('_ga=GA1.1.1; _ga_TEST123=GS1.1; vt_attr=abc; session=xyz')
    saveConsent(GA4_ID, 'denied')
    expect(calls(env.context.window.dataLayer as IArguments[]).at(-1)).toEqual(['consent', 'update', { analytics_storage: 'denied' }])
    expect(env.cookieWrites.sort()).toEqual(
      [
        '_ga=; Max-Age=0; Path=/',
        '_ga=; Max-Age=0; Path=/; Domain=.www.example.test',
        '_ga=; Max-Age=0; Path=/; Domain=.example.test',
        '_ga_TEST123=; Max-Age=0; Path=/',
        '_ga_TEST123=; Max-Age=0; Path=/; Domain=.www.example.test',
        '_ga_TEST123=; Max-Age=0; Path=/; Domain=.example.test',
      ].sort(),
    )
    expect(env.appended).toEqual([])
  })

  it('页面上有 Clarity 时同步同意状态；只配了 Clarity（ga4Id 为空）时接受也不加载 gtag.js', () => {
    const env = browser(null, 'https://example.test/')
    const clarity = vi.fn()
    Object.assign(env.context.window, { clarity })
    for (const [key, value] of Object.entries(env.context)) vi.stubGlobal(key, value)
    saveConsent('', 'granted')
    saveConsent('', 'denied')
    expect(clarity.mock.calls).toEqual([
      ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }],
      ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' }],
    ])
    expect(env.appended).toEqual([])
  })
})
