/**
 * 通用执行器 —— 把「钩子形态」翻译成「跑哪些层的中间件」。
 *
 * 这里不认识任何具体层名。层是数据（core/hooks.js 的 LAYERS），
 * 所以加一层 / 换一个钩子形态都不需要改这个文件。
 *
 * 三种形态：
 *   object          waterfall 给一个对象，层各改各的字段（可多个层并行在同一对象上）
 *   messages        waterfall 给一个带 messages 的决策对象
 *   session-method  包装 session 上的同步方法，返回值是数组
 */
import { HOOKS, LAYERS, groupFields } from './hooks.js'

/**
 * @param {object} deps
 * @param {import('./pipeline.js').Pipeline} deps.pipeline
 * @param {import('./journal.js').Journal} deps.journal
 * @param {(hostContext:object, extra:object)=>object} deps.forgeContext
 * @param {()=>Set<string>} deps.closedLayers
 * @param {(layerId:string)=>boolean} deps.layerEnabled 该层此刻是否启用（配置说了算）
 * @param {Record<string,object>} [deps.layers]
 */
export function createRunner({ pipeline, journal, forgeContext, closedLayers, layerEnabled, layers = LAYERS }) {
  const groups = Object.fromEntries(Object.keys(HOOKS).map((id) => [id, groupFields(id, layers)]))

  const fail = (hook, error) =>
    journal?.record({ layer: 'core', id: `hook:${hook}`, op: 'error', note: String(error?.message || error) })

  /** 该钩子上声明过的全部层 id。 */
  const layerIdsOnHook = (hookId) => [...(groups[hookId]?.values() ?? [])].flat()

  /**
   * 该钩子此刻有没有活可干（用于启动时决定要不要接线）。
   *
   * 只看**配置里该层是否启用**，不看"当前有没有已注册的中间件" ——
   * 否则 mods 异步加载晚于启动时，L3 这类没有内置中间件的层会永远接不上。
   */
  const isLive = (hookId) => layerIdsOnHook(hookId).some((id) => layerEnabled(id))

  /**
   * object 形态：逐字段跑。
   * 不同字段互不影响；只有真的被改过才复制对象（引用不变 = 零开销）。
   */
  async function runObject(hookId, original, hostContext) {
    if (!original || typeof original !== 'object') return original
    let out = original

    for (const [field, ids] of groups[hookId] ?? []) {
      if (!ids.some((id) => layerEnabled(id))) continue
      const closed = closedLayers()

      const value = Array.isArray(original[field]) ? original[field] : []
      const ctx = forgeContext(hostContext, { hook: hookId, field, layer: ids[0] })
      const next = await pipeline.run(hookId, value, ctx, { closedLayers: closed, only: new Set(ids) })

      if (next === value) continue
      if (out === original) out = { ...original }
      out[field] = next
    }

    return out
  }

  /** messages 形态：整个数组交给该钩子上的所有层。 */
  async function runMessages(hookId, messages, hostContext) {
    const ids = layerIdsOnHook(hookId)
    if (!ids.some((id) => layerEnabled(id))) return messages
    const closed = closedLayers()
    const ctx = forgeContext(hostContext, { hook: hookId, field: 'messages' })
    return pipeline.run(hookId, messages, ctx, { closedLayers: closed, only: new Set(ids) })
  }

  /**
   * session-method 形态：包装同步方法。
   *
   * 深冻结的消息对象不可变，只能替换；用 WeakMap 记住「源消息 → 改写后消息」，
   * 否则每轮都造新对象，宿主那边的 frozenMessages Set 会一直长。
   */
  function wrapSessionMethod(hookId, session, method, mark) {
    if (!session || typeof session[method] !== 'function' || session[mark]) return
    const ids = layerIdsOnHook(hookId)
    if (!ids.some((id) => layerEnabled(id))) return

    const original = session[method].bind(session)
    const memo = new WeakMap()
    const only = new Set(ids)

    session[method] = function wrappedMethod(...args) {
      const base = original(...args)
      if (!ids.some((id) => layerEnabled(id))) return base
      const closed = closedLayers()

      let next
      try {
        const ctx = forgeContext({ agent: { session } }, { hook: hookId, field: 'messages', session })
        next = pipeline.runSync(hookId, base, ctx, { closedLayers: closed, only })
      } catch (error) {
        fail(hookId, error)
        return base
      }
      if (!Array.isArray(next) || next.length !== base.length) return base

      return next.map((message, index) => {
        const source = base[index]
        if (message === source || !source || typeof source !== 'object') return source
        const cached = memo.get(source)
        if (cached) return cached
        memo.set(source, message)
        return message
      })
    }

    Object.defineProperty(session, mark, { value: true, enumerable: false })
    journal?.record({ layer: 'core', id: `hook:${hookId}`, op: 'install', note: String(session.id ?? '') })
  }

  return { runObject, runMessages, wrapSessionMethod, fail, layerIdsOnHook, isLive, groups }
}
