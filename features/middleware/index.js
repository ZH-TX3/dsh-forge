/**
 * forge.middleware —— 中间件管线。
 *
 * 落点：`system-prompt/assemble` 瀑布（预设作用域内）。
 * 契约只有一句：**(同型数组, ctx) => 同型数组**。
 *
 * 与 v1 的区别：不再有「四层 × N 个钩子」的矩阵。装配里可改的字段就三个
 * （sections / contexts / tools），外加一个整体替换。层是数据（FIELDS 表），
 * 加字段不需要改本文件。
 *
 * 热插拔：`data/mods/*.mjs`，按 mtime 重新 import。丢文件即生效，
 * 改文件即重载，不需要重装 bundle。
 *
 * 铁律：mod 出错只记日志并保留上一版值；本插件自己永不抛。
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'forge-middleware'
export const inject = ['systemPrompt']

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 可改字段表：字段名 → 在装配对象上的键。加字段只改这里。 */
const FIELDS = Object.freeze({
  sections: 'sections',
  contexts: 'contexts',
  tools: 'tools',
  assembly: null, // 整体替换：拿整个 assembly
})

const FIELD_ORDER = Object.freeze(['assembly', 'sections', 'contexts', 'tools'])
const DEFAULT_PRIORITY = 1000

/** 同一 mod 文件在 mtime 不变时复用同一个 import 结果。 */
const importCache = new Map()

function listMods(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.mjs') && !d.name.startsWith('_'))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

function normalize(spec, file, seq) {
  const id = typeof spec?.id === 'string' && spec.id.trim() ? spec.id.trim() : `mod:${file}`
  const field = spec?.field ?? spec?.layer ?? 'sections'
  if (!(field in FIELDS)) throw new TypeError(`mod ${id}：未知 field ${JSON.stringify(field)}（可用：${Object.keys(FIELDS).join(' / ')}）`)
  if (typeof spec?.apply !== 'function') throw new TypeError(`mod ${id}：需要 apply(value, ctx) 函数`)
  return {
    id,
    field,
    priority: Number.isFinite(spec.priority) ? Number(spec.priority) : DEFAULT_PRIORITY,
    note: typeof spec.note === 'string' ? spec.note : '',
    file,
    seq,
    apply: spec.apply,
  }
}

function compare(a, b) {
  return FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field) || a.priority - b.priority || a.seq - b.seq
}

export function apply(ctx, config = {}) {
  const dir = path.resolve(ROOT, String(config.dir || 'data/mods'))
  const journal = []
  const record = (line) => {
    journal.push({ at: new Date().toISOString(), ...line })
    if (journal.length > 100) journal.shift()
  }

  let items = []
  let seq = 0
  let lastScan = 0
  let stamp = ''

  /** 重新扫描目录；只有 (文件名+mtime+size) 指纹变了才重新 import。 */
  async function reload() {
    const now = Date.now()
    if (now - lastScan < (config.rescanMs ?? 1000)) return items
    lastScan = now

    const files = listMods(dir)
    const parts = []
    for (const file of files) {
      const abs = path.join(dir, file)
      try {
        const st = fs.statSync(abs)
        parts.push(`${file}:${st.mtimeMs}:${st.size}`)
      } catch {
        /* 扫描期间消失，忽略 */
      }
    }
    const next = parts.join('|')
    if (next === stamp) return items
    stamp = next

    const loaded = []
    let n = 0
    for (const file of files) {
      const abs = path.join(dir, file)
      try {
        const st = fs.statSync(abs)
        const key = `${abs}@${st.mtimeMs}:${st.size}`
        let namespace = importCache.get(key)
        if (!namespace) {
          // Node 的 ESM 注册表按 URL 缓存，只给自建 map 换 key 没用 ——
          // 必须把指纹写进 URL 查询串，才能拿到新模块。
          namespace = await import(`${pathToFileURL(abs).href}?v=${st.mtimeMs}-${st.size}`)
          importCache.set(key, namespace)
        }
        const spec = namespace.default ?? namespace
        loaded.push(normalize(spec, file, n++))
      } catch (error) {
        record({ id: `mod:${file}`, op: 'error', note: String(error?.message || error) })
      }
    }
    items = loaded.sort(compare)
    return items
  }

  /** 跑一个字段上的全部 mod。出错 → 保留上一版值。 */
  function runField(field, value, modCtx) {
    let current = value
    for (const mod of items) {
      if (mod.field !== field) continue
      try {
        const next = mod.apply(current, modCtx)
        if (next === undefined) continue
        current = next
      } catch (error) {
        record({ id: mod.id, op: 'error', field, note: String(error?.message || error) })
      }
    }
    return current
  }

  ctx.effect(
    () =>
      ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        const result = await next()
        try {
          if ((await reload()).length === 0) return result
          const modCtx = Object.freeze({ scope: context?.scope, stack: items.map((m) => m.id) })
          const out = runField('assembly', result, modCtx)
          return { ...out, ...Object.fromEntries(['sections', 'contexts', 'tools'].map((f) => [f, runField(f, out[f], modCtx)])) }
        } catch (error) {
          record({ id: 'middleware', op: 'error', note: String(error?.message || error) })
          return result
        }
      }),
    'forge.middleware.assemble()',
  )

  return {
    dir,
    get mods() {
      return items.map((m) => ({ id: m.id, field: m.field, priority: m.priority, note: m.note, file: m.file }))
    },
    journal: () => journal.slice(-20),
    reload,
  }
}

export default { name, inject, apply }
