/**
 * 中间件管线 —— 本插件唯一的核心。
 *
 * 一个契约覆盖所有层：每层的中间件都是
 *
 *     (同类型数组, ctx) => 同类型数组
 *
 * 中间件最小写法（丢进 mods/ 就能跑）：
 *
 *     export default {
 *       id: 'mod:my-rule',
 *       layer: 'L1',
 *       apply(sections) { return sections },
 *     }
 *
 * 设计要点：
 *   1. 内置中间件与用户中间件走同一条管线 —— 核心不为内置功能开后门。
 *   2. 顺序完全由 (hook, layer 声明序, priority, 注册序) 决定，可预测。
 *   3. 内置中间件出错即抛；用户中间件出错只记日志并跳过。
 *   4. 管线不认识"四个层"这件事 —— 层是数据（core/hooks.js 的 LAYERS），
 *      加一层不需要改这里，也不需要改 index.js。
 */
import { LAYER_IDS, LAYERS as CORE_LAYERS, HOOK_IDS } from './hooks.js'

export { LAYERS, LAYER_IDS, HOOKS, HOOK_IDS, groupFields, hookHasLayers, hookIsSync } from './hooks.js'

export const DEFAULT_PRIORITY = 1000

/** 排序：钩子声明序 → 层声明序 → priority → 注册序。全部来自数据表，无硬编码。 */
function compare(a, b) {
  return (
    HOOK_IDS.indexOf(a.hook) - HOOK_IDS.indexOf(b.hook) ||
    LAYER_IDS.indexOf(a.layer) - LAYER_IDS.indexOf(b.layer) ||
    a.priority - b.priority ||
    a._seq - b._seq
  )
}

function bad(spec, why) {
  return new TypeError(`dsh-forge: 无效中间件 ${JSON.stringify(spec?.id ?? null)}：${why}`)
}

/** 校验并补默认值。origin 决定出错时的兜底行为。 */
export function normalize(spec, origin = 'builtin', seq = 0, layers = CORE_LAYERS) {
  if (!spec || typeof spec !== 'object') throw bad(spec, '必须是对象')
  if (typeof spec.id !== 'string' || !spec.id.trim()) throw bad(spec, '需要非空字符串 id')
  const meta = layers[spec.layer]
  if (!meta) throw bad(spec, `未知 layer ${JSON.stringify(spec.layer)}（已声明：${Object.keys(layers).join(' / ')}）`)
  if (typeof spec.apply !== 'function') throw bad(spec, '需要 apply(value, ctx) 函数')

  return {
    id: spec.id.trim(),
    layer: spec.layer,
    hook: meta.hook,
    field: meta.field,
    sync: meta.sync === true,
    priority: Number.isFinite(spec.priority) ? Number(spec.priority) : DEFAULT_PRIORITY,
    // builtin 出错要炸；mods 出错只记日志。
    optional: spec.optional === true || (spec.optional !== false && origin !== 'builtin'),
    describe: typeof spec.describe === 'string' ? spec.describe : '',
    origin,
    _seq: seq,
    apply: spec.apply,
  }
}

export class Pipeline {
  #items = []
  #seq = 0
  #journal
  #overrides
  #layers

  /**
   * @param {object} opts
   * @param {import('./journal.js').Journal} opts.journal
   * @param {Record<string, boolean>} [opts.overrides] 单条中间件开关覆盖
   * @param {Record<string, object>} [opts.layers] 层声明表（默认 core/hooks.js 的 LAYERS）
   */
  constructor({ journal, overrides = {}, layers = CORE_LAYERS } = {}) {
    this.#journal = journal ?? null
    this.#overrides = overrides && typeof overrides === 'object' ? overrides : {}
    this.#layers = layers
  }

  /** 注册/替换（同 id 覆盖，便于热重载）。 */
  register(spec, origin = 'builtin') {
    const seq = this.#seq + 1
    const mw = normalize(spec, origin, seq, this.#layers)
    this.#seq = seq
    const at = this.#items.findIndex((x) => x.id === mw.id)
    if (at >= 0) this.#items[at] = mw
    else this.#items.push(mw)
    this.#items.sort(compare)
    return mw
  }

  /** 批量注册。任一失败则整体抛错（内置代码写错应该在启动时就暴露）。 */
  registerAll(specs, origin = 'builtin') {
    const added = []
    for (const spec of Array.isArray(specs) ? specs : []) added.push(this.register(spec, origin))
    return added
  }

  has(id) {
    return this.#items.some((x) => x.id === id)
  }

  /** 该中间件此刻是否生效。覆盖 > 层关闭 > 默认开。 */
  enabled(mw, closedLayers = null) {
    const override = this.#overrides[mw.id]
    if (override === false) return false
    if (override === true) return true
    if (closedLayers && closedLayers.has(mw.layer)) return false
    return true
  }

  /** 该层在 hook 上是否还有启用的中间件（用于跳过判断，零成本短路）。 */
  activeOn(layer, hook, closedLayers = null) {
    return this.#items.some((mw) => mw.layer === layer && mw.hook === hook && this.enabled(mw, closedLayers))
  }

  /** 一组层里有没有任一活跃。 */
  activeAny(layers, hook, closedLayers = null) {
    return layers.some((layer) => this.activeOn(layer, hook, closedLayers))
  }

  /**
   * 跑一条 hook 上的中间件。
   * @param {string} hook
   * @param {any[]} value
   * @param {object} ctx 传给中间件的上下文
   * @param {{closedLayers?: Set<string>, only?: Set<string>}} [opts] only = 只跑这些层
   * @returns {Promise<any[]>}
   */
  async run(hook, value, ctx, opts = {}) {
    const closedLayers = opts.closedLayers ?? null
    const only = opts.only ?? null
    let current = value
    this.#journal?.touch(hook)

    for (const mw of this.#items) {
      if (mw.hook !== hook) continue
      if (only && !only.has(mw.layer)) continue
      if (!this.enabled(mw, closedLayers)) continue
      let next
      try {
        next = await mw.apply(current, ctx)
      } catch (error) {
        this.#journal?.record({ layer: mw.layer, id: mw.id, op: 'error', note: String(error?.message || error) })
        if (!mw.optional) throw error
        continue
      }
      if (next === undefined || next === null) continue
      if (!Array.isArray(next)) {
        const error = new TypeError(`dsh-forge: 中间件 ${mw.id} 必须返回数组，得到 ${typeof next}`)
        this.#journal?.record({ layer: mw.layer, id: mw.id, op: 'error', note: error.message })
        if (!mw.optional) throw error
        continue
      }
      current = next
    }

    return current
  }

  /**
   * 同步版 run。给返回值必须同步的钩子用（如包装 `session.deriveMessages()`）。
   * 返回 Promise 的中间件会被当成错误并跳过。
   */
  runSync(hook, value, ctx, opts = {}) {
    const closedLayers = opts.closedLayers ?? null
    const only = opts.only ?? null
    let current = value
    this.#journal?.touch(hook)

    for (const mw of this.#items) {
      if (mw.hook !== hook) continue
      if (only && !only.has(mw.layer)) continue
      if (!this.enabled(mw, closedLayers)) continue
      let next
      try {
        next = mw.apply(current, ctx)
        if (next && typeof next.then === 'function') throw new TypeError(`${mw.id} 在同步钩子上必须同步`)
      } catch (error) {
        this.#journal?.record({ layer: mw.layer, id: mw.id, op: 'error', note: String(error?.message || error) })
        if (!mw.optional) throw error
        continue
      }
      if (next === undefined || next === null) continue
      if (!Array.isArray(next)) {
        this.#journal?.record({ layer: mw.layer, id: mw.id, op: 'error', note: '返回值不是数组' })
        continue
      }
      current = next
    }

    return current
  }

  /** 状态页数据。 */
  list() {
    return this.#items.map((mw) => ({
      id: mw.id,
      layer: mw.layer,
      hook: mw.hook,
      field: mw.field,
      priority: mw.priority,
      origin: mw.origin,
      optional: mw.optional,
      describe: mw.describe,
      enabled: this.enabled(mw),
    }))
  }

  countByLayer() {
    const out = Object.fromEntries(Object.keys(this.#layers).map((id) => [id, 0]))
    for (const mw of this.#items) out[mw.layer] += 1
    return out
  }
}
