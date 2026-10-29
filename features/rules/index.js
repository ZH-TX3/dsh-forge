/**
 * forge.rules —— L1b 硬规则。
 *
 * 落点：`systemPrompt.context()`，一条 md 一个 context，文件名前缀即顺序。
 *
 * 存在的理由（v1 最重要的发现，在 v2 变成结构保证）：
 * `complete: true` 的段会把 sections 收成单段，但 **contexts 永远保留**。
 * 所以「必须生效、不能被收尾吃掉」的短规则放这里，长人设放 persona。
 *
 * 只读 `<dir>/*.md`；没有文件就等于没有硬规则，不报错、不拦装配。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listMarkdown, readText } from '../../lib/files.js'

export const name = 'forge-rules'
export const inject = ['systemPrompt']

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function mount(ctx, config = {}) {
  const dir = path.resolve(ROOT, String(config.dir || 'data/rules'))
  const baseOrder = Number.isFinite(config.order) ? Number(config.order) : 100
  const files = listMarkdown(dir)
  const mounted = []
  const failed = []

  files.forEach((file, index) => {
    const abs = path.join(dir, file)
    const id = file.replace(/\.md$/i, '')
    try {
      ctx.effect(
        () =>
          ctx.systemPrompt.context({
            name: `forge:rule:${id}`,
            order: baseOrder + index,
            text: () => readText(abs) ?? '',
          }),
        `forge.rules.${id}`,
      )
      mounted.push(id)
    } catch (error) {
      failed.push({ id, error: String(error?.message || error) })
    }
  })

  if (failed.length > 0) {
    console.warn(`[forge] rules 部分未挂载：${failed.map((f) => `${f.id}:${f.error}`).join(', ')}`)
  }

  return { dir, rules: mounted, failed, ok: failed.length === 0 }
}

/**
 * 预设挂载入口。**必须不返回任何值** —— Cordis 把 apply 的返回值当成 effect，
 * 返回普通对象会抛 "Invalid effect"，插件静默挂不上（现象是这一行不动）。
 * 需要句柄的测试与脚本调 `mount()`。
 */
export function apply(ctx, config = {}) {
  mount(ctx, config)
}

export default { name, inject, apply }
