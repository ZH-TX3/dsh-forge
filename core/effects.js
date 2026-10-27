/**
 * EFFECTS —— 第二张声明表：**行为注入**，不是数据改写。
 *
 * 为什么不塞进 LAYERS：四层的契约是 `(数组) => 数组`，纯函数、可单测。
 * 但「请求失败自动重试」这类东西没有输入输出数组，它只是挂一个监听器。
 * 硬塞进去只会逼着代码假装有个数组。所以单开一张表，同样是数据驱动。
 *
 * 与 LAYERS 一样：加一项效果 = 加一行，不改 index.js。
 */

/** 这些错误码重试也没用，直接放行给宿主抛。 */
const PERMANENT_CODES = new Set([
  'AUTH',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INVALID_REQUEST',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'BILLING',
  'MODEL_NOT_FOUND',
  'CONTEXT_OVERFLOW',
  'CONTEXT_LENGTH',
  'CONTEXT_WINDOW_EXCEEDED',
  'NO_ADAPTER',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
])

export const EFFECTS = Object.freeze({
  'request-retry': {
    default: true,
    title: '请求失败自动重试',
    detail:
      '宿主在 agent/request-error 上默认不重试（next 返回 undefined 即抛错）。本效果在非永久错误上返回 {kind:"retry"}，按 turn+step 计预算。',
    install({ ctx, journal, options }) {
      const max = Math.max(0, Math.min(10, Number(options?.max ?? 3)))
      if (max === 0) return { status: 'off', detail: 'retryMax=0' }

      const used = new Map()
      const keyOf = (payload) =>
        `${payload?.agent?.session?.id ?? ''}:${payload?.turn ?? 0}:${payload?.step ?? 0}`

      const handler = async (payload, next) => {
        // 先让下游（宿主的 retryPolicy / 其它插件）表态，不抢决策。
        const action = typeof next === 'function' ? await next() : undefined
        if (action?.kind === 'retry') return action

        const code = String(payload?.failure?.code ?? '')
        if (PERMANENT_CODES.has(code)) return action

        const key = keyOf(payload)
        const count = (used.get(key) ?? 0) + 1
        if (count > max) return action
        used.set(key, count)
        // 预算表按 session 内 turn+step 增长，天然有限；超过 500 条整体清一次。
        if (used.size > 500) used.clear()

        journal?.record({
          layer: 'E',
          id: 'request-retry',
          op: 'retry',
          note: `#${count}/${max} ${code || '(无 code)'}`,
        })
        return { kind: 'retry' }
      }

      const dispose = ctx.on('agent/request-error', handler, { prepend: true })
      journal?.record({ layer: 'E', id: 'request-retry', op: 'install', note: `max=${max}` })
      return { status: 'installed', disposers: [dispose] }
    },
  },

  'continue-turn': {
    default: false,
    title: '异常结束自动续跑（未实现）',
    detail:
      '宿主 agent/status 只 emit {status}，拿不到 agent 句柄，无法安全地补发 followup。' +
      'purge 用 payload.agent，但在 0.2.0-rc.2 里该字段不存在。留占位，不猜 API。',
    install() {
      return { status: 'unsupported', detail: '需要宿主 emit 带 agent 句柄的事件' }
    },
  },
})

export const EFFECT_IDS = Object.freeze(Object.keys(EFFECTS))

/**
 * 安装效果。
 * @param {{ctx:object, config:object, journal:object}} deps
 */
export function installEffects({ ctx, config, journal }) {
  const results = []
  const disposers = []
  const wants = config?.effects || {}

  for (const [id, effect] of Object.entries(EFFECTS)) {
    const conf = wants[id]
    const options = conf && typeof conf === 'object' ? conf : {}
    const enabled = typeof conf === 'boolean' ? conf : (typeof options.enabled === 'boolean' ? options.enabled : effect.default === true)
    if (!enabled) {
      results.push({ id, enabled: false, status: 'off', title: effect.title })
      continue
    }
    try {
      const out = effect.install({ ctx, config, journal, options }) || { status: 'noop' }
      if (Array.isArray(out.disposers)) disposers.push(...out.disposers)
      results.push({ id, enabled: true, status: out.status, detail: out.detail, title: effect.title })
    } catch (error) {
      results.push({ id, enabled: true, status: 'error', detail: String(error?.message || error), title: effect.title })
      journal?.record({ layer: 'E', id, op: 'error', note: String(error?.message || error) })
    }
  }

  return { results, disposers }
}

export function describeEffects(config) {
  const wants = config?.effects || {}
  return EFFECT_IDS.map((id) => {
    const conf = wants[id]
    const options = conf && typeof conf === 'object' ? conf : {}
    const enabled = typeof conf === 'boolean' ? conf : (typeof options.enabled === 'boolean' ? options.enabled : EFFECTS[id].default === true)
    return {
      id,
      title: EFFECTS[id].title,
      detail: EFFECTS[id].detail,
      default: EFFECTS[id].default === true,
      options: { ...options, enabled: undefined },
      enabled,
    }
  })
}
