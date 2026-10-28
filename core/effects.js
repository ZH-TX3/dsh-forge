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
    install({ ctx, journal, options, isActive = () => true }) {
      const max = Math.max(0, Math.min(10, Number(options?.max ?? 3)))
      if (max === 0) return { status: 'off', detail: 'retryMax=0' }

      const used = new Map()
      const keyOf = (payload) =>
        `${payload?.agent?.session?.id ?? ''}:${payload?.turn ?? 0}:${payload?.step ?? 0}`

      const handler = async (payload, next) => {
        // 先让下游（宿主的 retryPolicy / 其它插件）表态，不抢决策。
        const action = typeof next === 'function' ? await next() : undefined
        if (!isActive()) return action
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
    title: '异常结束自动续跑',
    detail:
      'agent/status 的 payload 由 dsh-agent 的 agentEvents() 融合了 { agent }（dsh-agent/lib/index.js:243 fused），' +
      '所以拿得到 agent 句柄、可以补发 followup。只在上一轮以 error/aborted/interrupted/max-tokens 结束、' +
      '且不是用户主动取消时触发，按 turn 计预算。',
    install({ ctx, journal, options, isActive = () => true }) {
      const max = Math.max(0, Math.min(10, Number(options?.max ?? 3)))
      if (max === 0) return { status: 'off', detail: 'continueMax=0' }
      const text = String(options?.text ?? '继续').trim() || '继续'
      const delayMs = Math.max(0, Math.min(5000, Number(options?.delayMs ?? 280)))

      const budget = new Map() // sessionId -> { seq, count }
      const timers = new Set()

      const maybeContinue = (agent) => {
        if (!isActive()) return
        if (typeof agent?.followup !== 'function') return
        if (agent.status === 'running' || inboxBusy(agent)) return

        const events = sessionEvents(agent)
        const end = lastTurnEnd(events)
        if (!end || shouldSkipContinue(end.data?.reason)) return
        if (hasFreshHumanTurn(events, end)) return

        const sid = String(agent?.session?.id ?? agent?.id ?? '')
        const seq = Number(end.seq ?? 0)
        const prev = budget.get(sid)
        const count = prev && prev.seq === seq ? prev.count : 0
        if (count >= max) return
        budget.set(sid, { seq, count: count + 1 })
        if (budget.size > 500) budget.clear()

        try {
          agent.followup(continueMessage(text))
          journal?.record({ layer: 'E', id: 'continue-turn', op: 'continue', note: `#${count + 1}/${max}` })
        } catch (error) {
          budget.set(sid, { seq, count })
          journal?.record({ layer: 'E', id: 'continue-turn', op: 'error', note: String(error?.message || error) })
        }
      }

      const handler = (payload) => {
        if (payload?.status !== 'idle' || !payload?.agent) return
        const agent = payload.agent
        // 留一拍：idle 与用户 submit 存在竞态，purge 同样用 280ms。
        const timer = setTimeout(() => {
          timers.delete(timer)
          maybeContinue(agent)
        }, delayMs)
        timers.add(timer)
      }

      const dispose = ctx.on('agent/status', handler, { prepend: true })
      journal?.record({ layer: 'E', id: 'continue-turn', op: 'install', note: `max=${max}` })
      return {
        status: 'installed',
        disposers: [
          dispose,
          () => {
            for (const timer of timers) clearTimeout(timer)
            timers.clear()
          },
        ],
      }
    },
  },
})


/* ------------------------------------------------------------------ continue-turn 判定 */

/** 这些结束原因值得续跑；其它（normal / max-turns / 用户取消）一律不管。 */
const ABNORMAL_REASONS = new Set(['error', 'aborted', 'interrupted', 'max-tokens'])

/** 官方已经重试过、或新开一轮也解决不了的，不发"继续"。 */
const NO_CONTINUE_CODES = new Set([...PERMANENT_CODES, 'RATE_LIMIT', 'TRANSPORT'])

function sessionEvents(agent) {
  const session = agent?.session
  if (!session) return []
  try {
    if (typeof session.snapshotEvents === 'function') {
      const got = session.snapshotEvents()
      if (Array.isArray(got)) return got
    }
  } catch {
    /* 读不到就用 events */
  }
  return Array.isArray(session.events) ? session.events : []
}

function lastTurnEnd(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'turn/end') return events[i]
  }
  return null
}

/** 该不该放弃这一轮。true = 别发"继续"。 */
function shouldSkipContinue(reason) {
  if (!reason || !ABNORMAL_REASONS.has(String(reason.kind))) return true
  if (reason.kind === 'aborted' && (reason.reason === 'user' || reason.reason === 'cancel')) return true
  const code = String(reason.code ?? reason.failure?.code ?? '').toUpperCase()
  return code !== '' && NO_CONTINUE_CODES.has(code)
}

/** turn/end 之后有没有用户自己发言 —— 有就说明用户接上了，别再替他续。 */
function hasFreshHumanTurn(events, end) {
  const seq = Number(end?.seq ?? 0)
  return events.some((event) => {
    if ((event?.seq ?? 0) <= seq || event?.type !== 'user/message') return false
    const kind = String(event?.data?.source?.kind ?? '')
    return kind !== 'plugin' && kind !== 'dsh-forge' && kind !== 'dsh-purge'
  })
}

function inboxBusy(agent) {
  try {
    const inbox = agent?.inbox
    if (!inbox) return false
    if (typeof inbox.hasPending === 'function') return Boolean(inbox.hasPending())
    if (typeof inbox.size === 'number') return inbox.size > 0
    if (typeof inbox.length === 'number') return inbox.length > 0
  } catch {
    /* inbox 形状变了就别拦 */
  }
  return false
}

function continueMessage(text) {
  return {
    id: `dsh-forge-continue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-forge', form: 'notice', summary: 'continue' },
  }
}

export const EFFECT_IDS = Object.freeze(Object.keys(EFFECTS))

/**
 * 安装效果。
 * @param {{ctx:object, config:object, journal:object}} deps
 */
export function installEffects({ ctx, config, journal, isActive = () => true }) {
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
      const out = effect.install({ ctx, config, journal, options, isActive }) || { status: 'noop' }
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
