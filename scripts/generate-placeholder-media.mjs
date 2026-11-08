// 生成原创占位媒体（不含任何第三方素材）。上新词时用真实授权素材替换同名文件即可。
// 用法：node scripts/generate-placeholder-media.mjs   （需要本机 ffmpeg）
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { site } from '../src/config/site.ts'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const demoDir = join(root, 'public', 'demo')
const templateDir = join(root, 'seed', 'templates')
const fixtureDir = join(root, 'tests', 'fixtures')
for (const dir of [demoDir, templateDir, fixtureDir]) mkdirSync(dir, { recursive: true })

const W = 540
const H = 960

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
}

// 霓虹舞台：渐变背景 + 扫动的光束 + 中央跳动的“舞者”色块
function stageFilter([c0, c1, c2], seconds) {
  return [
    `gradients=s=${W}x${H}:c0=${c0}:c1=${c1}:c2=${c2}:n=3:speed=0.015:d=${seconds}:r=24`,
    `drawbox=x='mod(t*220\\,${W + 120})-120':y=0:w=60:h=${H}:color=white@0.12:t=fill`,
    `drawbox=x='${W}-mod(t*160\\,${W + 160})':y=0:w=90:h=${H}:color=white@0.08:t=fill`,
    `drawbox=x='${W / 2 - 70}+60*sin(t*4)':y='${H / 2 - 120}+30*abs(sin(t*8))':w=140:h=300:color=black@0.55:t=fill`,
    `drawbox=x='${W / 2 - 40}+60*sin(t*4)':y='${H / 2 - 210}+30*abs(sin(t*8))':w=80:h=80:color=black@0.55:t=fill`,
    `drawbox=x=0:y=${H - 140}:w=${W}:h=140:color=black@0.35:t=fill`,
    'format=yuv420p',
  ].join(',')
}

function video(file, palette, seconds) {
  ffmpeg([
    '-f', 'lavfi', '-i', stageFilter(palette, seconds),
    '-f', 'lavfi', '-i', `sine=frequency=220:beep_factor=4:sample_rate=44100:duration=${seconds}`,
    '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '64k', file,
  ])
}

function poster(videoFile, file) {
  ffmpeg(['-ss', '1', '-i', videoFile, '-frames:v', '1', '-q:v', '4', file])
}

const palettes = {
  original: ['0xff2bd6', '0x2b1055', '0x00e5ff'],
  ai1: ['0xff8a00', '0x3a0ca3', '0xff2bd6'],
  ai2: ['0x00f5a0', '0x0b1d51', '0x00b3ff'],
  madeWith: ['0xffd60a', '0x7b2cbf', '0xff4d6d'],
}

for (const [name, palette] of Object.entries(palettes)) {
  const file = join(demoDir, `${name}.mp4`)
  video(file, palette, 6)
  poster(file, join(demoDir, `${name}.jpg`))
}

// 生成用模板源视频：每个时长档位一段（provider 输出时长 = 源视频时长），文件名跟 site.styles[].sources 走
for (const style of site.styles) {
  for (const { id, seconds } of site.durations) {
    video(join(templateDir, style.sources[id]), palettes.original, seconds)
  }
}

// 示例“用户照片”（抽象人像剪影）+ e2e 上传 fixture
const portrait =
  "geq=r='if(lt(hypot(X-270\\,Y-260)\\,105)\\,40\\,if(lt(hypot(X-270\\,Y-640)\\,230)*lt(Y\\,720)*gt(Y\\,420)\\,40\\,200+40*Y/H))'" +
  ":g='if(lt(hypot(X-270\\,Y-260)\\,105)\\,30\\,if(lt(hypot(X-270\\,Y-640)\\,230)*lt(Y\\,720)*gt(Y\\,420)\\,30\\,150+60*X/W))'" +
  ":b='if(lt(hypot(X-270\\,Y-260)\\,105)\\,60\\,if(lt(hypot(X-270\\,Y-640)\\,230)*lt(Y\\,720)*gt(Y\\,420)\\,60\\,230))'"
ffmpeg(['-f', 'lavfi', '-i', `color=s=540x720:d=1,${portrait}`, '-frames:v', '1', '-q:v', '3', join(demoDir, 'sample-photo.jpg')])
ffmpeg(['-i', join(demoDir, 'sample-photo.jpg'), '-vf', 'scale=300:400', '-q:v', '5', join(fixtureDir, 'photo.jpg')])

// OG 图：1200x630 渐变 + 品牌名（Windows 用 Georgia，其他系统可改字体路径）
const font = process.platform === 'win32' ? 'C\\:/Windows/Fonts/georgiab.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'
const brand = process.env.BRAND_NAME ?? site.brandName
ffmpeg([
  '-f', 'lavfi',
  '-i', `gradients=s=1200x630:c0=0xff2bd6:c1=0x2b1055:c2=0x00e5ff:n=3:d=1,drawtext=fontfile='${font}':text='${brand}':fontsize=88:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-30,drawtext=fontfile='${font}':text='AI Video Generator':fontsize=40:fontcolor=white@0.85:x=(w-text_w)/2:y=(h/2)+60`,
  '-frames:v', '1', join(root, 'public', 'og.png'),
])

console.log('placeholder media generated')
