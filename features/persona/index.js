/**
 * forge.persona —— L1 长人设。
 *
 * 落点：`systemPrompt.section()`。注册在**调用方作用域**里 —— 预设挂载时
 * 宿主给的是一个 scoped ctx，所以这一段只进「锻造模式」的装配，
 * 别的模式装配里连这个名字都不存在。
 *
 * `complete: true` 时装配收尾把本段作为唯一 prompt section：整套替换默认人设，
 * 工具 schema 与 contexts 不受影响。该语义也只在本 scope 内成立。
 *
 * 失败模式：人设文件缺失时给出显式占位文本，绝不返回空串
 * （空串 + complete 会把系统提示词整体清空）。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, readText } from '../../lib/files.js'

export const name = 'forge-persona'
export const inject = ['systemPrompt']

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SECTION = 'forge:persona'

export function mount(ctx, config = {}) {
  try {
    const abs = path.resolve(ROOT, String(config.file || 'data/prompts/base.md'))
    const order = Number.isFinite(config.order) ? Number(config.order) : 100

    // complete 在注册期决定：文件此刻就不在，就不要整套替换，
    // 否则一次误删会把该模式的系统提示词清成占位符。
    const complete = config.complete === true && exists(abs)

    const text = () => {
      const body = readText(abs)
      if (body !== null && body.trim() !== '') return body
      return `<!-- forge: 人设文件读不到 -->\n人设文件缺失：${abs}`
    }

    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: SECTION,
          order,
          text,
          interpolate: false,
          ...(complete ? { complete: true } : {}),
        }),
      'forge.persona.section()',
    )

    return { section: SECTION, file: abs, complete, ok: true }
  } catch (error) {
    // apply 内自兜底：预设里一行挂不上会连累整个预设，错误必须在这里消化。
    console.warn(`[forge] persona 未挂载：${error?.message || error}`)
    return { ok: false, error: String(error?.message || error) }
  }
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
