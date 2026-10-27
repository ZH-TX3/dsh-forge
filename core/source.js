/**
 * 提示词正文来源。
 *
 * 只有一条规则：**第一个非空的来源胜出**，顺序固定、可预期。
 *   1. config.promptFile（用户指定的文件）
 *   2. prompts/base.md（插件自带默认）
 *
 * 按 mtime 缓存，改文件即时生效（无需重启）。
 * 明文，不做任何加密 —— 加密只能防呆，反而让 diff / 审阅 / 版本化全部失效。
 */
import fs from 'node:fs'
import { promptPath } from './config.js'

const cache = new Map()

/** 读文件，带 mtime 缓存。返回 null 表示文件不存在。 */
export function readIfExists(file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return null
    const hit = cache.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text
    const text = fs.readFileSync(file, 'utf8')
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, text })
    return text
  } catch {
    return null
  }
}

/**
 * 解析本轮的提示词正文。
 * @param {object} cfg resolveConfig() 的结果
 * @returns {{ text: string, from: string, exists: boolean }}
 */
export function resolvePrompt(cfg) {
  const file = promptPath(cfg)
  const text = readIfExists(file)
  if (text === null) return { text: '', from: file, exists: false }
  return { text, from: file, exists: true }
}

export function clearCache() {
  cache.clear()
}
