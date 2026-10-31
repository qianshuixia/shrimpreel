import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONSENT_KEY } from '#/lib/consent'

// 最小浏览器环境：document.cookie 按名字存取，记录每次写入；fetch 只记录调用
// regionDefault：服务端写在 <html data-consent-default> 上的地区默认值
function browser(consent: string | null, initialCookie = '', regionDefault = 'denied') {
  const jar = new Map<string, string>()
  for (const part of initialCookie.split(';').filter(Boolean)) {
    const [name, value] = part.trim().split('=')
    jar.set(name!, value!)
  }
  const writes: string[] = []
  const document = {
    referrer: 'https://news.example.org/post/1',
    documentElement: { getAttribute: (name: string) => (name === 'data-consent-default' ? regionDefault : null) },
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    },
    set cookie(raw: string) {
      writes.push(raw)
      const [pair, ...attrs] = raw.split('; ')
      const [name, value] = pair!.split('=')
      if (attrs.includes('Max-Age=0')) jar.delete(name!)
      else jar.set(name!, value!)
    },
  }
  const store = new Map<string, string>()
  const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
  vi.stubGlobal('window', {})
  vi.stubGlobal('document', document)
  vi.stubGlobal('location', new URL('https://www.example.test/pricing?utm_source=launch&utm_medium=social'))
  vi.stubGlobal('localStorage', { getItem: (key: string) => (key === CONSENT_KEY ? consent : null), setItem: vi.fn() })
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) })
  vi.stubGlobal('fetch', fetch)
  return { jar, writes, fetch }
}

const decode = (value: string) => JSON.parse(Buffer.from(value, 'base64url').toString())

// pending 是模块级状态，每个用例重新加载模块
async function load() {
  return import('#/lib/attribution')
}

describe('captureAttribution', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())

  it('没有配置 GA4：直接写 vt_attr，并上报一次访问', async () => {
    const env = browser(null)
    const { captureAttribution } = await load()
    captureAttribution(false)
    expect(decode(env.jar.get('vt_attr')!).first).toMatchObject({ utm_source: 'launch', landing: '/pricing', referrer: 'https://news.example.org/post/1' })
    expect(env.fetch).toHaveBeenCalledTimes(1)
  })

  it('默认开启统计 Cookie 的地区、还没选择：直接写 vt_attr；拒绝过的访客仍不写', async () => {
    const env = browser(null, '', 'granted')
    const { captureAttribution } = await load()
    captureAttribution(true)
    expect(decode(env.jar.get('vt_attr')!).first).toMatchObject({ utm_source: 'launch' })

    vi.resetModules()
    const denied = browser('denied', '', 'granted')
    ;(await load()).captureAttribution(true)
    expect(denied.jar.has('vt_attr')).toBe(false)
  })

  it('配置了 GA4、还没选择：不写 Cookie，访问照常上报；接受后补写本次触达，只写一次', async () => {
    const env = browser(null)
    const { captureAttribution, applyAttributionConsent } = await load()
    captureAttribution(true)
    expect(env.writes).toEqual([])
    expect(env.fetch).toHaveBeenCalledTimes(1)

    applyAttributionConsent('granted')
    expect(decode(env.jar.get('vt_attr')!).last).toMatchObject({ utm_source: 'launch', utm_medium: 'social' })
    applyAttributionConsent('granted')
    expect(env.writes).toHaveLength(1)
  })

  it('已接受的回访者：保留首次触达，并按有来源的新触达更新 last', async () => {
    const first = { landing: '/', at: '2026-10-01T00:00:00.000Z', utm_source: 'old' }
    const cookie = Buffer.from(JSON.stringify({ first, last: first })).toString('base64url')
    const env = browser('granted', `vt_attr=${cookie}`)
    const { captureAttribution } = await load()
    captureAttribution(true)
    const stored = decode(env.jar.get('vt_attr')!)
    expect(stored.first).toEqual(first)
    expect(stored.last).toMatchObject({ utm_source: 'launch' })
  })

  it('拒绝过：删除之前写下的 vt_attr，不再写入；之后撤回或拒绝都只删除', async () => {
    const env = browser('denied', 'vt_attr=abc; session=xyz')
    const { captureAttribution, applyAttributionConsent } = await load()
    captureAttribution(true)
    expect(env.jar.has('vt_attr')).toBe(false)
    expect(env.jar.get('session')).toBe('xyz')

    applyAttributionConsent('denied')
    expect(env.writes.every((w) => w.startsWith('vt_attr=; Max-Age=0'))).toBe(true)
  })

  it('接受后又撤回：删除 vt_attr，之后再接受也不会写回撤回前的触达', async () => {
    const env = browser(null)
    const { captureAttribution, applyAttributionConsent } = await load()
    captureAttribution(true)
    applyAttributionConsent('granted')
    expect(env.jar.has('vt_attr')).toBe(true)
    applyAttributionConsent('denied')
    expect(env.jar.has('vt_attr')).toBe(false)
    applyAttributionConsent('granted')
    expect(env.jar.has('vt_attr')).toBe(false)
  })
})
