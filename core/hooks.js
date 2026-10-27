/**
 * 钩子与层的**声明式**注册表 —— 本插件唯一的耦合面，而且只是数据。
 *
 * 两个概念分开：
 *
 *   HOOK   「宿主在哪一刻给我入口」。数量有限，由 DSH 定义，装一次。
 *   LAYER  「我在这条钩子上改哪份数据」。可以随便加，纯数据，不改代码。
 *
 * 想加一层（比如 L4 = 工具结果、L5 = 审批文案）：在 LAYERS 里加一行。
 * 想接一个新钩子（比如宿主新发了 `tool/result` 事件）：在 HOOKS 里加一行。
 * 两种情况都**不需要**碰 index.js —— index.js 只是遍历这两张表。
 *
 * 三种 hook 形态覆盖了目前所有已知入口，够用且不会膨胀：
 *   object         —— waterfall 产出一个对象，层声明自己改哪个字段（可多层并行）
 *   messages       —— waterfall 产出一个带 messages 的决策对象
 *   session-method —— 包装 session 上的同步方法（返回值是数组）
 */

/** 层声明。id 即配置里的键，也是中间件 `layer` 字段要填的值。 */
export const LAYERS = Object.freeze({
  L1: { hook: 'assemble', field: 'sections', defaultOn: true, sync: false, title: 'system prompt' },
  L1b: { hook: 'assemble', field: 'contexts', defaultOn: true, sync: false, title: 'runtime context' },
  L2: { hook: 'pre-step', field: 'messages', defaultOn: false, sync: false, title: 'user message' },
  L3: { hook: 'history', field: 'messages', defaultOn: false, sync: true, title: 'assistant 历史' },
})

export const LAYER_IDS = Object.freeze(Object.keys(LAYERS))

/** 钩子声明。install(env) 负责把这一条钩子接到宿主上。 */
export const HOOKS = Object.freeze({
  assemble: {
    event: 'system-prompt/assemble',
    mode: 'object',
    title: '装配（sections / contexts）',
    install(env) {
      env.ctx.on(
        'system-prompt/assemble',
        async (assembly, hostContext, next) => {
          // 先让下游跑完，再改写结果（post-processing，不抢官方逻辑）。
          const original = typeof next === 'function' ? await next() : assembly
          try {
            return await env.runObject('assemble', original, hostContext)
          } catch (error) {
            // 改写失败绝不能让宿主发不出请求。
            env.fail('assemble', error)
            return original
          }
        },
        { global: true, prepend: true },
      )
    },
  },

  'pre-step': {
    event: 'agent/pre-step',
    mode: 'messages',
    title: '本轮用户消息',
    install(env) {
      env.ctx.on(
        'agent/pre-step',
        async (payload, next) => {
          const decision = typeof next === 'function' ? await next() : payload
          if (!decision || decision.kind !== 'enter') return decision
          try {
            const messages = await env.runMessages('pre-step', decision.messages ?? [], payload)
            return messages === decision.messages ? decision : { ...decision, messages }
          } catch (error) {
            env.fail('pre-step', error)
            return decision
          }
        },
        { prepend: true },
      )
    },
  },

  history: {
    event: 'session/created',
    mode: 'session-method',
    title: '派生给模型的历史',
    install(env) {
      const MARK = Symbol.for('dsh-forge.historyWrapped')
      env.ctx.on(
        'session/created',
        (session) => {
          try {
            env.wrapSessionMethod('history', session, 'deriveMessages', MARK)
          } catch (error) {
            env.fail('history', error)
          }
        },
        { global: true, prepend: true },
      )
    },
  },
})

export const HOOK_IDS = Object.freeze(Object.keys(HOOKS))

/** 某个钩子上，各字段分别由哪些层负责。纯数据推导，不改任何东西。 */
export function groupFields(hookId, layers = LAYERS) {
  const out = new Map()
  for (const [id, meta] of Object.entries(layers)) {
    if (!meta || meta.hook !== hookId) continue
    if (!out.has(meta.field)) out.set(meta.field, [])
    out.get(meta.field).push(id)
  }
  return out
}

/** 该钩子上有没有声明过任何层。没有就没必要接线。 */
export function hookHasLayers(hookId, layers = LAYERS) {
  return Object.values(layers).some((meta) => meta?.hook === hookId)
}

/** 该钩子上的层是否全是同步的（决定用 run 还是 runSync）。 */
export function hookIsSync(hookId, layers = LAYERS) {
  const metas = Object.values(layers).filter((meta) => meta?.hook === hookId)
  return metas.length > 0 && metas.every((meta) => meta.sync === true)
}
