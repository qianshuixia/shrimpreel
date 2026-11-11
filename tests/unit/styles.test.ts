import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ARTICLES, DISPLAY_STYLES, LOCALES, STYLES, defaultStyle, featuredStyle, findStyle, site, styleDurations, stylePhotoCount } from '#/config/site'
import { loadContent } from '#/lib/i18n'

// 风格配置的一致性：加风格时漏掉文案、源视频或 id 重复，在这里就能发现
describe('site.styles', () => {
  it('至少一个风格，第一个是默认风格，id 不重复', () => {
    expect(STYLES.length).toBeGreaterThan(0)
    expect(defaultStyle).toBe(STYLES[0])
    const ids = STYLES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(findStyle(id)?.id).toBe(id)
    expect(findStyle('no-such-style')).toBeUndefined()
  })

  it('主推风格的 id 存在（写错会悄悄退回默认风格），界面顺序以它开头且不漏风格', () => {
    if (site.featuredStyleId !== null) expect(findStyle(site.featuredStyleId), `featuredStyleId ${site.featuredStyleId}`).toBeDefined()
    expect(DISPLAY_STYLES[0]).toBe(featuredStyle)
    expect([...DISPLAY_STYLES].map((s) => s.id).sort()).toEqual(STYLES.map((s) => s.id).sort())
  })

  it('每个风格的 sources 覆盖所有时长档位，文件名不重复', () => {
    const files: string[] = []
    for (const style of STYLES) {
      for (const d of styleDurations(style)) {
        expect(style.sources[d.id], `${style.id} 缺 ${d.id} 的源视频`).toBeTruthy()
        files.push(style.sources[d.id]!)
      }
    }
    expect(new Set(files).size).toBe(files.length)
  })

  it('配了背景音乐的风格覆盖所有时长档位，文件是 seed/templates/ 里存在的 .m4a', () => {
    for (const style of STYLES) {
      if (!style.music) continue
      for (const d of styleDurations(style)) {
        const file = style.music[d.id]
        expect(file, `${style.id} 缺 ${d.id} 的背景音乐`).toBeTruthy()
        expect(file, `${style.id}/${d.id}`).toMatch(/\.m4a$/)
        expect(existsSync(`seed/templates/${file}`), `seed/templates/${file} 不存在`).toBe(true)
      }
    }
  })

  it('时长档位 id 在全站和所有风格里不重复（写入 generations.duration_id）', () => {
    const own = STYLES.flatMap((s) => (s.durations ?? []).map((d) => d.id))
    const ids = [...site.durations.map((d) => d.id), ...own]
    expect(new Set(ids).size).toBe(ids.length)
    for (const style of STYLES) expect(styleDurations(style).length, `${style.id} 没有时长档位`).toBeGreaterThan(0)
  })

  it('双人风格（photos = 2）必须固定走支持多图的 nanoapi', () => {
    for (const style of STYLES) {
      if (stylePhotoCount(style) === 2) expect(style.provider, `${style.id} 需要 provider: 'nanoapi'`).toBe('nanoapi')
    }
  })

  it('每个风格在每种语言都有展示名和介绍', async () => {
    for (const locale of LOCALES) {
      const content = await loadContent(locale)
      for (const style of STYLES) {
        const copy = (content.styles as Record<string, { name: string; tagline: string } | undefined>)[style.id]
        expect(copy?.name, `${locale}/${style.id}`).toBeTruthy()
        expect(copy?.tagline, `${locale}/${style.id}`).toBeTruthy()
      }
    }
  })

  it('文章绑定的 style 必须是存在的风格 id', () => {
    for (const article of ARTICLES) {
      if (article.style !== undefined) expect(findStyle(article.style), `${article.key}.style = ${article.style}`).toBeTruthy()
    }
  })
})
