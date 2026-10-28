/**
 * forge.capability-protocol —— 能力使用协议。
 *
 * 落点：`systemPrompt.context()`，一条 context。
 *
 * 为什么用 context 不用 section：section 会被 `complete: true` 的收尾吃掉，
 * 而协议属于「必须每次都在」的那类文本 —— 和 L1b 硬规则同理。
 *
 * purge 把同类文本塞进 section，还得靠重排 waterfall 把它挪到最前；
 * 用 context 就没有顺序问题：contexts 按 order 拼，永远保留。
 *
 * 文本在 `data/capability-protocol.md`，改文件即生效。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readText } from '../../lib/files.js'

export const name = 'forge-capability-protocol'
export const inject = ['systemPrompt']

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONTEXT_NAME = 'forge:capability-protocol'

export function apply(ctx, config = {}) {
  if (config.enabled === false) return { ok: true, skipped: true }

  const abs = path.resolve(ROOT, String(config.file || 'data/capability-protocol.md'))
  const order = Number.isFinite(config.order) ? Number(config.order) : 50

  try {
    ctx.effect(
      () =>
        ctx.systemPrompt.context({
          name: CONTEXT_NAME,
          order,
          text: () => {
            const body = readText(abs)
            return body !== null && body.trim() !== '' ? body : ''
          },
        }),
      'forge.capability-protocol.context()',
    )
    return { ok: true, name: CONTEXT_NAME, file: abs }
  } catch (error) {
    console.warn(`[forge] capability-protocol 未挂载：${error?.message || error}`)
    return { ok: false, error: String(error?.message || error) }
  }
}

export default { name, inject, apply }
