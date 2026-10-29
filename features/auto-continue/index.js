/**
 * forge.auto-continue —— 异常结束后自动续跑。
 *
 * 落点：`agent/status`（idle 时）+ `session/event`（记 turn/end 判决），
 * 延迟 280ms 后重跑整条判决链，通过则 `agent.followup(继续)`。
 *
 * **默认关闭**。purge 的默认也是关：idle → 280ms 之间如果用户自己按了提交，
 * 就会和续跑抢。开它之前先确认你能接受这个竞态。
 *
 * 判决链（顺序即代码顺序，全过才发）：
 *   1 enabled
 *   2 不忙：status 不是 running，且 inbox 没有挂起消息
 *   3 没有新的人类发言（上一次 turn/end 之后没有用户消息）
 *   4 结束原因属于「异常」：error / aborted / interrupted / max-tokens
 *     （completed / blocked / forked 不续）
 *   5 不是用户主动取消
 *   6 错误码不在不可续表（永久码 + RATE_LIMIT + TRANSPORT）
 *   7 预算没超，且不是同一 seq 重复续
 *
 * 码表来自 purge 实测值，做成数据（config.codes 可覆盖），代码里不硬编码语义。
 */

export const name = 'forge-auto-continue'

/** 重试/续跑都没意义的终态码。 */
export const PERMANENT_CODES = Object.freeze([
  'AUTH',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INVALID',
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

/** 值得重试，但不该「自己接着往下干」的（等一会儿让用户或退避逻辑接手）。 */
export const NO_CONTINUE_CODES = Object.freeze([...PERMANENT_CODES, 'RATE_LIMIT', 'TRANSPORT'])

/** 只有这几种结束原因算「没干完」。 */
export const ABNORMAL_REASONS = Object.freeze(['error', 'aborted', 'interrupted', 'max-tokens'])

function codeOf(reason) {
  const raw = reason?.error?.code ?? reason?.failure?.code ?? reason?.code ?? ''
  return String(raw || '').toUpperCase()
}

/**
 * 外部取消：这些原因引起的结束**不该**被续跑。
 *
 * 比 purge 宽一格：purge 只认 user / cancel，而它在 aborted 分支取错了字段
 * （取 `reason.error.code`，真实取消原因在 `reason.reason`），结果 parent / hook /
 * disposed 引起的取消全部漏过闸、被当成「可干完了」自动再起一轮。
 * 这里把外部取消列全，宁可少续不可乱续。
 */
export const EXTERNAL_CANCEL_CAUSES = Object.freeze(['user', 'cancel', 'parent', 'hook', 'disposed'])

export function isExternalCancel(reason) {
  const cause = reason?.cause?.kind ?? reason?.cause
  if (typeof cause === 'string' && EXTERNAL_CANCEL_CAUSES.includes(cause)) return true
  const tag = reason?.reason ?? reason?.cancelCause
  return typeof tag === 'string' && EXTERNAL_CANCEL_CAUSES.includes(tag)
}

/**
 * 纯判决：给一个已摊平的快照，回答「该不该续」。
 * 导出是为了离线断言 —— 不需要真 Agent、不需要真定时器。
 *
 * @param input { reason, kind, cancelled, errorCode, status, inboxBusy,
 *                freshHuman, used, max, lastSeq, seq }
 * @param config { enabled, max, codes: string[], abnormal: string[] }
 */
export function shouldContinue(input = {}, config = {}) {
  if (config?.enabled !== true) return false
  if (input.status === 'running') return false
  if (input.inboxBusy) return false
  if (input.freshHuman) return false

  const kind = String(input.kind ?? '')
  const abnormal = Array.isArray(config?.abnormal) ? config.abnormal : ABNORMAL_REASONS
  if (kind && !abnormal.includes(kind)) return false
  if (!kind && input.reason === undefined) return false

  if (input.cancelled === true || isExternalCancel(input.reason)) return false

  const noContinue = Array.isArray(config?.codes) ? config.codes.map((c) => String(c).toUpperCase()) : NO_CONTINUE_CODES
  const code = String(input.errorCode ?? codeOf(input.reason) ?? '').toUpperCase()
  // 空码视为可续（和 purge 一致：拿不到码不等于拿到了终态码）。
  if (code && noContinue.includes(code)) return false

  const max = Number.isFinite(config?.max) ? Number(config.max) : 3
  const used = Number.isFinite(input.used) ? Number(input.used) : 0
  if (used >= max) return false
  if (input.lastSeq !== undefined && input.seq !== undefined && input.lastSeq === input.seq) return false

  return true
}

export function mount(ctx, config = {}) {
  const enabled = config.enabled === true
  const delayMs = Number.isFinite(config.delayMs) ? Number(config.delayMs) : 280
  const text = typeof config.text === 'string' && config.text.trim() ? config.text : '继续'
  const maxFailures = Number.isFinite(config.maxFailures) ? Number(config.maxFailures) : 3

  const lastTurn = new Map() // sessionId -> { seq, kind, reason, errorCode }
  const tracker = new Map() // sessionId -> { used, lastSeq, failures }
  const timers = new Set()
  const log = []
  const record = (line) => {
    log.push({ at: new Date().toISOString(), ...line })
    if (log.length > 100) log.shift()
  }

  const slot = (id) => {
    let s = tracker.get(id)
    if (!s) {
      s = { used: 0, lastSeq: -1, failures: 0 }
      tracker.set(id, s)
    }
    return s
  }

  // 只观察，不改事件。turn/end 是宿主自己的持久事件类型，我们不新造。
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        if (event?.type !== 'turn/end') return
        lastTurn.set(session.id, {
          seq: event.seq,
          kind: event.reason?.kind ?? event.reason,
          reason: event.reason,
          errorCode: codeOf(event.reason),
        })
      }),
    'forge.auto-continue.turn-end()',
  )

  ctx.effect(
    () =>
      ctx.on('agent/status', (payload) => {
        if (!enabled) return
        if (payload?.status !== 'idle') return
        const agent = payload.agent
        const id = agent?.id
        if (!id) return

        const timer = setTimeout(() => {
          timers.delete(timer)
          try {
            const s = slot(id)
            if (s.failures >= maxFailures) return
            const turn = lastTurn.get(id) ?? {}
            const inbox = agent?.inbox
            const inboxBusy = Boolean(
              inbox?.hasPending?.() ?? (inbox?.size > 0 || inbox?.length > 0),
            )
            const ok = shouldContinue(
              {
                kind: turn.kind,
                reason: turn.reason,
                errorCode: turn.errorCode,
                status: agent?.status,
                inboxBusy,
                freshHuman: false, // 定时器到点时以 inbox 复查代替（见下）
                used: s.used,
                max: Number.isFinite(config.max) ? Number(config.max) : 3,
                seq: turn.seq,
                lastSeq: s.lastSeq,
              },
              config,
            )
            if (!ok) return
            agent.followup({
              id: `forge-continue-${id}-${turn.seq ?? 0}`,
              role: 'user',
              content: [{ type: 'text', text }],
            })
            s.used += 1
            s.lastSeq = turn.seq ?? s.lastSeq
            record({ op: 'continue', session: id, seq: turn.seq ?? null })
          } catch (error) {
            slot(id).failures += 1
            record({ op: 'error', session: id, note: String(error?.message || error) })
          }
        }, delayMs)

        timers.add(timer)
      }),
    'forge.auto-continue.idle()',
  )

  ctx.effect(
    () => () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    },
    'forge.auto-continue.dispose()',
  )

  return { journal: () => log.slice(-20) }
}

/**
 * 预设挂载入口。**必须不返回任何值** —— Cordis 把 apply 的返回值当成 effect，
 * 返回普通对象会抛 "Invalid effect"，插件静默挂不上（现象是这一行不动）。
 * 需要句柄的测试与脚本调 `mount()`。
 */
export function apply(ctx, config = {}) {
  mount(ctx, config)
}

export default { name, apply }
