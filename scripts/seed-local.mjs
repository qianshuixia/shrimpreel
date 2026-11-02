// 本地初始化：应用 D1 迁移 + 把 seed/templates/ 的模板源视频（和两步走用的首帧图、背景音乐 m4a）上传到本地 R2（templates/<文件名>）
// 用法：npm run seed:local   （与 vite dev / wrangler dev 共享 .wrangler/state）
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const bucket = readFileSync('wrangler.jsonc', 'utf8').match(/"bucket_name":\s*"([^"]+)"/)?.[1]
if (!bucket) throw new Error('wrangler.jsonc 中找不到 r2_buckets[].bucket_name')

const wrangler = (args) => execFileSync('npx', ['wrangler', ...args], { stdio: 'inherit', shell: process.platform === 'win32' })

wrangler(['d1', 'migrations', 'apply', 'DB', '--local'])

const dir = join('seed', 'templates')
const TYPES = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.m4a': 'audio/mp4' }
for (const file of readdirSync(dir)) {
  const type = TYPES[file.slice(file.lastIndexOf('.'))]
  if (!type) continue
  wrangler(['r2', 'object', 'put', `${bucket}/templates/${file}`, '--file', join(dir, file), '--content-type', type, '--local'])
}
