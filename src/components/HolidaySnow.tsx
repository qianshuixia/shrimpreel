import { useEffect, useRef } from 'react'
import { site } from '#/config/site'

type SpriteKind = 'orb' | 'crystal' | 'bokeh' | 'gold'

interface Flake {
  x: number
  y: number
  z: number
  size: number
  speedY: number
  swayFreq: number
  swayAmp: number
  phase: number
  twinkleFreq: number
  baseAlpha: number
  rotation: number
  spin: number
  kind: SpriteKind
}

// 预渲染离屏雪花精灵：运行期每帧仅做 GPU drawImage，完全避免昂贵的实时 shadowBlur / createRadialGradient
function buildSprites(dark: boolean): Record<SpriteKind, HTMLCanvasElement> {
  const make = (size: number, draw: (ctx: CanvasRenderingContext2D, r: number) => void) => {
    const c = document.createElement('canvas')
    c.width = size
    c.height = size
    const ctx = c.getContext('2d')
    if (ctx) draw(ctx, size / 2)
    return c
  }

  // 1. 柔光雪粒（中远景主雪花）：亮色模式下用“纯白高光芯 + 冰雾浅蓝晕”，在浅底上既洁白又清晰
  const orb = make(32, (ctx, r) => {
    const g = ctx.createRadialGradient(r, r, 0, r, r, r)
    if (dark) {
      g.addColorStop(0, 'rgba(255, 255, 255, 1)')
      g.addColorStop(0.4, 'rgba(242, 249, 255, 0.85)')
      g.addColorStop(0.75, 'rgba(215, 236, 255, 0.25)')
      g.addColorStop(1, 'rgba(215, 236, 255, 0)')
    } else {
      g.addColorStop(0, 'rgba(255, 255, 255, 1)')
      g.addColorStop(0.42, 'rgba(222, 237, 250, 0.96)')
      g.addColorStop(0.76, 'rgba(92, 132, 168, 0.48)')
      g.addColorStop(1, 'rgba(92, 132, 168, 0)')
    }
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(r, r, r, 0, Math.PI * 2)
    ctx.fill()
  })

  // 2. 前景虚化大散景（DSLR 景深效果）
  const bokeh = make(64, (ctx, r) => {
    const g = ctx.createRadialGradient(r, r, 0, r, r, r)
    if (dark) {
      g.addColorStop(0, 'rgba(255, 255, 255, 0.78)')
      g.addColorStop(0.5, 'rgba(235, 246, 255, 0.38)')
      g.addColorStop(0.85, 'rgba(220, 238, 255, 0.1)')
      g.addColorStop(1, 'rgba(220, 238, 255, 0)')
    } else {
      g.addColorStop(0, 'rgba(255, 255, 255, 0.96)')
      g.addColorStop(0.52, 'rgba(205, 226, 244, 0.56)')
      g.addColorStop(0.84, 'rgba(104, 142, 176, 0.24)')
      g.addColorStop(1, 'rgba(104, 142, 176, 0)')
    }
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(r, r, r, 0, Math.PI * 2)
    ctx.fill()
  })

  // 3. 精致六瓣冰晶枝丫（慢速旋转飘落，带柔和冰晕）
  const crystal = make(64, (ctx, r) => {
    const glow = ctx.createRadialGradient(r, r, 0, r, r, r)
    if (dark) {
      glow.addColorStop(0, 'rgba(255, 255, 255, 0.52)')
      glow.addColorStop(0.6, 'rgba(210, 235, 255, 0.14)')
      glow.addColorStop(1, 'rgba(210, 235, 255, 0)')
    } else {
      glow.addColorStop(0, 'rgba(255, 255, 255, 0.94)')
      glow.addColorStop(0.58, 'rgba(130, 168, 202, 0.34)')
      glow.addColorStop(1, 'rgba(130, 168, 202, 0)')
    }
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(r, r, r, 0, Math.PI * 2)
    ctx.fill()

    ctx.save()
    ctx.translate(r, r)
    ctx.strokeStyle = dark ? 'rgba(255, 255, 255, 0.96)' : 'rgba(78, 122, 160, 0.92)'
    ctx.lineCap = 'round'
    const arm = r * 0.72
    for (let i = 0; i < 6; i++) {
      ctx.save()
      ctx.rotate((i * Math.PI) / 3)
      ctx.lineWidth = 1.8
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(0, -arm)
      ctx.stroke()

      // 两级细枝分叉，呈现自然冰晶质感
      ctx.lineWidth = 1.25
      for (const [pos, len] of [
        [0.44, 0.26],
        [0.72, 0.2],
      ] as const) {
        const y = -arm * pos
        const b = arm * len
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(-b * 0.72, y - b * 0.68)
        ctx.moveTo(0, y)
        ctx.lineTo(b * 0.72, y - b * 0.68)
        ctx.stroke()
      }
      ctx.restore()
    }
    // 中心六角高光点
    ctx.fillStyle = dark ? 'rgba(255, 255, 255, 1)' : 'rgba(255, 255, 255, 0.96)'
    ctx.beginPath()
    ctx.arc(0, 0, 2.4, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  })

  // 4. 暖金圣诞星尘散景（少量点缀，营造圣诞树暖灯氛围）
  const gold = make(40, (ctx, r) => {
    const g = ctx.createRadialGradient(r, r, 0, r, r, r)
    if (dark) {
      g.addColorStop(0, 'rgba(255, 236, 179, 0.95)')
      g.addColorStop(0.45, 'rgba(235, 192, 92, 0.45)')
      g.addColorStop(1, 'rgba(235, 192, 92, 0)')
    } else {
      g.addColorStop(0, 'rgba(255, 245, 210, 0.95)')
      g.addColorStop(0.45, 'rgba(218, 165, 58, 0.48)')
      g.addColorStop(1, 'rgba(218, 165, 58, 0)')
    }
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(r, r, r, 0, Math.PI * 2)
    ctx.fill()
  })

  return { orb, crystal, bokeh, gold }
}

function createFlake(width: number, height: number, scatter: boolean): Flake {
  const z = Math.random()
  const roll = Math.random()
  let kind: SpriteKind = 'orb'
  let size = 4 + z * z * 9.5
  let baseAlpha = 0.45 + z * 0.48

  if (z > 0.82 && roll < 0.65) {
    kind = 'bokeh'
    size = 18 + (z - 0.82) * 95
    baseAlpha = 0.3 + Math.random() * 0.28
  } else if (roll < 0.26 && z > 0.25) {
    kind = 'crystal'
    size = 14 + z * 14
    baseAlpha = 0.56 + z * 0.38
  } else if (roll > 0.88) {
    kind = 'gold'
    size = 8 + z * 12
    baseAlpha = 0.36 + z * 0.32
  }

  return {
    x: Math.random() * (width + 60) - 30,
    y: scatter ? Math.random() * height : -size - Math.random() * 60,
    z,
    size,
    speedY: (0.38 + z * 1.12) * 38,
    swayFreq: 0.45 + Math.random() * 0.85,
    swayAmp: 10 + Math.random() * 24,
    phase: Math.random() * Math.PI * 2,
    twinkleFreq: 0.7 + Math.random() * 1.2,
    baseAlpha,
    rotation: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * 0.55,
    kind,
  }
}

/**
 * 圣诞主题专属轻量 Canvas 飘雪层（仅 site.theme === 'holiday' 渲染）：
 * - 离屏精灵缓存 + drawImage，主线程 < 0.4ms/帧
 * - 滚出视口（IntersectionObserver）或切后台自动暂停，零空转耗电
 * - 遵循 prefers-reduced-motion，实时响应亮/暗主题切换
 */
export function HolidaySnow() {
  if (site.theme !== 'holiday') return null
  return <HolidaySnowCanvas />
}

function HolidaySnowCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let dark = document.documentElement.dataset.theme === 'dark'
    let sprites = buildSprites(dark)

    let width = 0
    let height = 0
    let dpr = 1
    let flakes: Flake[] = []

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      width = rect.width
      height = rect.height
      dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const target = width < 640 ? 60 : width < 1024 ? 105 : 145
      if (flakes.length === 0) {
        flakes = Array.from({ length: target }, () => createFlake(width, height, true))
      } else if (flakes.length < target) {
        while (flakes.length < target) flakes.push(createFlake(width, height, true))
      } else if (flakes.length > target) {
        flakes.length = target
      }
    }

    const drawFrame = (dt: number, elapsed: number) => {
      if (width === 0 || height === 0) return
      ctx.clearRect(0, 0, width, height)
      // 轻柔变化的全局冬风
      const globalWind = Math.sin(elapsed * 0.25) * 14 + Math.cos(elapsed * 0.11) * 7
      const fadeStart = height * 0.82
      const fadeSpan = Math.max(height * 0.18, 1)

      for (let i = 0; i < flakes.length; i++) {
        const f = flakes[i]!
        if (dt > 0) {
          f.y += f.speedY * dt
          const sway = Math.sin(elapsed * f.swayFreq + f.phase) * f.swayAmp
          f.x += (sway + globalWind * (0.4 + f.z * 0.6)) * dt
          if (f.kind === 'crystal') f.rotation += f.spin * dt

          if (f.y > height + f.size) {
            flakes[i] = createFlake(width, height, false)
            continue
          }
          if (f.x < -f.size - 40) f.x = width + f.size + 20
          else if (f.x > width + f.size + 40) f.x = -f.size - 20
        }

        // 底部柔和淡出，避免硬截断
        const edgeFade = f.y > fadeStart ? Math.max(0, 1 - (f.y - fadeStart) / fadeSpan) : 1
        const twinkle = 0.8 + 0.2 * Math.sin(elapsed * f.twinkleFreq + f.phase)
        const alpha = f.baseAlpha * twinkle * edgeFade
        if (alpha <= 0.01) continue

        const sprite = sprites[f.kind]
        ctx.globalAlpha = alpha
        if (f.kind === 'crystal') {
          ctx.save()
          ctx.translate(f.x, f.y)
          ctx.rotate(f.rotation)
          ctx.drawImage(sprite, -f.size / 2, -f.size / 2, f.size, f.size)
          ctx.restore()
        } else {
          ctx.drawImage(sprite, f.x - f.size / 2, f.y - f.size / 2, f.size, f.size)
        }
      }
      ctx.globalAlpha = 1
    }

    resize()

    // 减少动态偏好：只画一帧静谧雪景，不启循环
    if (reducedMotion) {
      drawFrame(0, 0)
      return
    }

    let rafId = 0
    let running = false
    let inView = true
    let lastTime = 0
    let elapsed = 0

    const tick = (now: number) => {
      if (!running) return
      const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0.016
      lastTime = now
      elapsed += dt
      drawFrame(dt, elapsed)
      rafId = requestAnimationFrame(tick)
    }

    const start = () => {
      if (running || document.hidden || !inView) return
      running = true
      lastTime = 0
      rafId = requestAnimationFrame(tick)
    }

    const stop = () => {
      running = false
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
    }

    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const io = new IntersectionObserver(
      (entries) => {
        inView = entries[0]?.isIntersecting ?? true
        if (inView) start()
        else stop()
      },
      { threshold: 0.01 },
    )
    io.observe(canvas)

    const onVisibility = () => {
      if (document.hidden) stop()
      else start()
    }
    document.addEventListener('visibilitychange', onVisibility)

    // 实时同步亮/暗主题切换，无需刷新页面
    const mo = new MutationObserver(() => {
      const nextDark = document.documentElement.dataset.theme === 'dark'
      if (nextDark !== dark) {
        dark = nextDark
        sprites = buildSprites(dark)
      }
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    start()

    return () => {
      stop()
      ro.disconnect()
      io.disconnect()
      mo.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
}
