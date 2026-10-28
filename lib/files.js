/**
 * 文件读取 —— 数据层唯一的 I/O 入口。
 *
 * 按 mtime+size 缓存：改 md 即生效，不需要重装、不需要重启。
 * 读不到返回 null，由调用方决定降级方式；这里不抛。
 */
import fs from 'node:fs'

const cache = new Map()

/** @returns {string | null} 文件全文；不存在或读失败返回 null。 */
export function readText(abs) {
  try {
    const st = fs.statSync(abs)
    const hit = cache.get(abs)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text
    const text = fs.readFileSync(abs, 'utf8')
    cache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, text })
    return text
  } catch {
    cache.delete(abs)
    return null
  }
}

/** @returns {boolean} */
export function exists(abs) {
  try {
    return fs.statSync(abs).isFile()
  } catch {
    return false
  }
}

/** 目录下的 .md 文件名，按名字排序（文件名前缀即顺序）。 */
export function listMarkdown(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md'))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

/** 清空缓存（verify 用；生产路径不需要）。 */
export function clearCache() {
  cache.clear()
}
