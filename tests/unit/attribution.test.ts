import { describe, expect, it } from 'vitest'
import { classifyTouch, deviceFromUserAgent, parseAttribution, sanitizeAttributionLabel } from '#/server/attribution'
import { csvCell } from '#/server/reports'

describe('classifyTouch', () => {
  it('广告点击 id 优先于 utm 和 referrer', () => {
    expect(classifyTouch({ gclid: 'x', utm_source: 'newsletter', utm_campaign: 'Spring' })).toEqual({
      source: 'google',
      medium: 'cpc',
      campaign: 'spring',
    })
    expect(classifyTouch({ msclkid: 'x' })).toMatchObject({ source: 'bing', medium: 'cpc' })
    expect(classifyTouch({ ttclid: 'x' })).toMatchObject({ source: 'tiktok', medium: 'cpc' })
  })

  it('utm_source / ref 次之，缺 utm_medium 记为 referral', () => {
    expect(classifyTouch({ utm_source: 'ProductHunt', utm_medium: 'Launch' })).toMatchObject({ source: 'producthunt', medium: 'launch' })
    expect(classifyTouch({ ref: 'theresanaiforthat' })).toMatchObject({ source: 'theresanaiforthat', medium: 'referral' })
    expect(classifyTouch({ fbclid: 'x' })).toMatchObject({ source: 'facebook', medium: 'social' })
  })

  it('referrer 归类：AI 助手先于搜索引擎（gemini.google.com 不算 google organic）', () => {
    expect(classifyTouch({ referrer: 'https://chatgpt.com/' })).toMatchObject({ source: 'chatgpt', medium: 'ai' })
    expect(classifyTouch({ referrer: 'https://gemini.google.com/app' })).toMatchObject({ source: 'gemini', medium: 'ai' })
    expect(classifyTouch({ referrer: 'https://www.google.com/' })).toMatchObject({ source: 'google', medium: 'organic' })
    expect(classifyTouch({ referrer: 'https://www.google.co.jp/' })).toMatchObject({ source: 'google', medium: 'organic' })
    expect(classifyTouch({ referrer: 'https://t.co/abc' })).toMatchObject({ source: 'x', medium: 'social' })
    expect(classifyTouch({ referrer: 'https://www.some-blog.dev/post' })).toMatchObject({ source: 'some-blog.dev', medium: 'referral' })
  })

  it('无信号、站内 referrer、非法 referrer 都算 direct', () => {
    expect(classifyTouch(undefined)).toMatchObject({ source: 'direct', medium: 'none' })
    expect(classifyTouch({ landing: '/' })).toMatchObject({ source: 'direct' })
    expect(classifyTouch({ referrer: 'https://www.example.com/pricing' }, 'example.com')).toMatchObject({ source: 'direct' })
    expect(classifyTouch({ referrer: 'not a url' })).toMatchObject({ source: 'direct' })
  })

  it('Google 登录、支付商结账页回跳不算来源（accounts.google.com 不是 google organic）', () => {
    for (const referrer of [
      'https://accounts.google.com/',
      'https://accounts.google.com.hk/',
      'https://checkout.dodopayments.com/session/x',
      'https://test.checkout.dodopayments.com/',
      'https://checkout.waffo.ai/',
      'https://checkout.stripe.com/c/pay/x',
    ]) {
      expect(classifyTouch({ referrer }), referrer).toMatchObject({ source: 'direct', medium: 'none' })
    }
    expect(classifyTouch({ referrer: 'https://accounts.google.com/', utm_source: 'github' })).toMatchObject({ source: 'github' })
    expect(classifyTouch({ referrer: 'https://www.google.com/search' })).toMatchObject({ source: 'google', medium: 'organic' })
  })

  it('归因标签剥离控制字符、换行及 HTML/Markdown/@ 提及符号', () => {
    expect(sanitizeAttributionLabel('<script>\n@everyone`test`[evil]</script>')).toBe('scripteveryonetestevil/script')
    expect(classifyTouch({ utm_source: 'bad\nsource@all', utm_medium: 'c[p]c', utm_campaign: '<camp>\r' })).toEqual({
      source: 'badsOURCEall'.toLowerCase(),
      medium: 'cpc',
      campaign: 'camp',
    })
  })
})

describe('parseAttribution', () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

  it('解析 base64url cookie，丢弃未知字段并截断超长值', () => {
    const parsed = parseAttribution(encode({ first: { utm_source: 'a'.repeat(500), evil: '<script>' }, last: { referrer: 'https://x.com/' } }))
    expect(parsed?.first).toEqual({ utm_source: 'a'.repeat(300) })
    expect(parsed?.last).toEqual({ referrer: 'https://x.com/' })
  })

  it('损坏或空 cookie 返回 null', () => {
    expect(parseAttribution(undefined)).toBeNull()
    expect(parseAttribution('%%%')).toBeNull()
    expect(parseAttribution(encode({ first: 'nope' }))).toBeNull()
    expect(parseAttribution('a'.repeat(5000))).toBeNull()
  })
})

describe('deviceFromUserAgent', () => {
  it('区分 bot / mobile / tablet / desktop', () => {
    expect(deviceFromUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe('bot')
    expect(deviceFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148')).toBe('mobile')
    expect(deviceFromUserAgent('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('tablet')
    expect(deviceFromUserAgent('Mozilla/5.0 (Linux; Android 15; SM-X910) Safari/537.36')).toBe('tablet')
    expect(deviceFromUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36')).toBe('mobile')
    expect(deviceFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0')).toBe('desktop')
  })
})

describe('csvCell', () => {
  it('转义引号/逗号，阻止公式注入，数字原样', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell(-300)).toBe('-300')
    expect(csvCell(null)).toBe('')
  })
})
