/**
 * L4 —— 落盘会话工装（**离线**，不在运行时改会话）。
 *
 * 会话文件是 `session.jsonl.zstd`：zstd 压缩的 JSONL。Node 24 自带
 * `zlib.zstdCompressSync/zstdDecompressSync`，所以零依赖。
 *
 * 为什么只做离线工具：
 *   运行时改落盘历史 = 必然污染上下文 + 破坏前缀缓存 + 不可自动回滚。
 *   同一件事做成离线命令，就变成「可预览、可备份、可复现」的修复工装。
 *
 * 每一条写路径都强制：
 *   读 → 改 → 语法/结构复核（行数、type 字段）→ 备份 → 写 → 回读验证
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * zstd 帧头魔数（小端字节 28 B5 2F FD）。
 *
 * 关键事实：**DSH 的会话文件是多帧拼接的**（追加写，一帧一段）。
 * 实测本机一个 212KB 的 session.jsonl.zstd 含 2 帧：
 *   offset 0   → 194 字节（1 条 session 事件）
 *   offset 179 → 剩下全部（900 条事件）
 *
 * 而 `zlib.zstdDecompressSync()` 和 `createZstdDecompress()` **都只解第一帧**，
 * 不报错、不提示 —— 直接读会得到 1 条事件，然后写回去就把整个会话毁了。
 * 所以这里必须自己按帧切开。
 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function magicOffsets(buf) {
  const out = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      out.push(i)
    }
  }
  return out
}

/**
 * 解压全部帧。
 * @returns {{ text: string, frames: number }}
 */
export function decompressAll(buf) {
  const offsets = magicOffsets(buf)
  if (offsets.length === 0) {
    throw new Error('文件里没有 zstd 帧头，不是会话文件')
  }
  if (offsets.length === 1) {
    return { text: zlib.zstdDecompressSync(buf).toString('utf8'), frames: 1 }
  }

  // 多帧：按帧头切段逐帧解压。任意一帧失败就整体报错，
  // 绝不退化成「只解第一帧」—— 那是静默截断。
  const chunks = []
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(start, end)))
    } catch (error) {
      throw new Error(
        `第 ${i + 1}/${offsets.length} 帧解压失败（offset ${start}）：${error?.message || error}。` +
          '为避免静默截断，已中止。',
      )
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), frames: offsets.length }
}

/** 解压并解析。返回 { text, events, frames }。 */
export function readSession(file) {
  const raw = fs.readFileSync(file)
  let text
  let frames = 0
  try {
    const out = decompressAll(raw)
    text = out.text
    frames = out.frames
  } catch (error) {
    throw new Error(`不是有效的 zstd 会话文件：${error?.message || error}`)
  }
  const events = text
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch {
        throw new Error(`第 ${index + 1} 行不是合法 JSON`)
      }
    })
  return { text, events, frames }
}

/** 统计：事件总数与 type 分布。 */
export function statSession(file) {
  const { text, events, frames } = readSession(file)
  const byType = {}
  for (const event of events) byType[event?.type || '(no type)'] = (byType[event?.type || '(no type)'] || 0) + 1
  return {
    bytes: fs.statSync(file).size,
    plainBytes: Buffer.byteLength(text, 'utf8'),
    frames,
    events: events.length,
    byType,
  }
}

/** 深度遍历事件里的所有字符串字段，交给 fn 决定是否改写。 */
export function mapStrings(value, fn, seen = new WeakSet()) {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn, seen))
  if (value && typeof value === 'object') {
    if (seen.has(value)) return value
    seen.add(value)
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, fn, seen)
    return out
  }
  return value
}

/**
 * 用正则遮蔽敏感串。
 * @param {string} file
 * @param {RegExp} pattern
 * @param {string} replacement
 * @param {{dryRun?:boolean, keepTypes?:string[]}} [opts]
 */
export function redactSession(file, pattern, replacement, opts = {}) {
  const { events } = readSession(file)
  const keep = Array.isArray(opts.keepTypes) ? new Set(opts.keepTypes) : null
  let hits = 0

  const next = events.map((event) => {
    if (keep && !keep.has(event?.type)) return event
    return mapStrings(event, (text) => {
      const out = text.replace(pattern, replacement)
      if (out !== text) hits += 1
      return out
    })
  })

  const preview = { file, events: events.length, hits, dryRun: opts.dryRun !== false }
  if (preview.dryRun) return preview
  if (hits === 0) return { ...preview, written: false, reason: '没有命中，不写盘' }

  writeSession(file, next)
  return { ...preview, dryRun: false, written: true }
}

/**
 * 写回。强制备份 + 回读校验。
 *
 * 输出**单帧**：任何帧数解码器至少能读到第一帧，所以单帧对宿主最安全。
 * （多帧是本项目读路径要兼容的格式，不是要制造的格式。）
 */
export function writeSession(file, events) {
  const payload = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  const packed = zlib.zstdCompressSync(Buffer.from(payload, 'utf8'))

  const bak = `${file}.forge.bak`
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak)

  fs.writeFileSync(file, packed)

  // 回读验证：能解压、行数一致、每条都有 type。
  const check = readSession(file)
  if (check.events.length !== events.length) {
    fs.copyFileSync(bak, file)
    throw new Error(`回读行数不一致（${check.events.length} != ${events.length}），已回滚`)
  }
  if (check.events.some((event) => !event?.type)) {
    fs.copyFileSync(bak, file)
    throw new Error('回读发现缺少 type 字段，已回滚')
  }

  return { file, bak, bytes: packed.length, events: events.length }
}

/** 还原。 */
export function restoreSession(file) {
  const bak = `${file}.forge.bak`
  if (!fs.existsSync(bak)) return { ok: false, reason: `没有备份：${bak}` }
  fs.copyFileSync(bak, file)
  fs.unlinkSync(bak)
  return { ok: true, file }
}

/** 把一个 cwd 目录下所有会话列出来。 */
export function listSessions(sessionsRoot) {
  const out = []
  const walk = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl.zstd')) out.push(full)
    }
  }
  walk(sessionsRoot)
  return out
}
