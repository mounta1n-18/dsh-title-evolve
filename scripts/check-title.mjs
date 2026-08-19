// 临时验证脚本：解压最新会话日志，检查 session/title 事件
// 用法: node check-title.mjs [会话目录]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2] || join(process.env.USERPROFILE || '', '.dsh', 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function frames(buf) {
  const out = []
  let i = 0
  while (i < buf.length - 4) {
    const idx = buf.indexOf(MAGIC, i)
    if (idx < 0) break
    // 粗略找帧尾：从 magic 后的帧头解析帧大小（FHD 可选）——简化：尝试解压，失败则跳过
    out.push(idx)
    i = idx + 4
  }
  return out
}

function decompressAll(buf) {
  const starts = frames(buf)
  const lines = []
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k]
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      const plain = zstdDecompressSync(buf.subarray(start, end))
      lines.push(...plain.toString('utf8').split('\n'))
    } catch {
      // 未完成的 torn 帧，忽略
    }
  }
  return lines
}

// 递归找最新 .zstd 文件
function newestZstd(dir) {
  let best = null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = newestZstd(p)
      if (sub && (!best || statSync(sub).mtimeMs > statSync(best).mtimeMs)) best = sub
    } else if (entry.name.endsWith('.zstd')) {
      if (!best || statSync(p).mtimeMs > statSync(best).mtimeMs) best = p
    }
  }
  return best
}

const file = process.argv[2] ? process.argv[2] : newestZstd(root)
if (!file) { console.log('no zstd files under', root); process.exit(0) }
console.log('newest:', file)
const lines = decompressAll(readFileSync(file))
const titles = []
for (const l of lines) {
  if (!l.trim()) continue
  try {
    const ev = JSON.parse(l)
    if (ev.type === 'session/title') titles.push(ev)
  } catch { /* 跳过非 JSON 行 */ }
}
console.log('total lines:', lines.length, '| title events:', titles.length)
for (const ev of titles.slice(-8)) {
  console.log('--- event seq', ev.seq, 'time', new Date(ev.time).toLocaleString(), '---')
  console.log(JSON.stringify(ev.data, null, 2))
}
