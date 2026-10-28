/**
 * forge.request-retry —— 请求失败兜底重试。
 *
 * 落点：`agent/request-error` 瀑布。
 * 签名：`(payload: { agent, turn, step, provider, failure, retryPolicy, signal }, next)`
 * 返回 `{ kind: 'retry' }` 让循环重试本次尝试，返回 `undefined` 表示不干预。
 *
 * 定位是**补充**，不是覆盖：
 *   宿主自己有 retryPolicy，先让它表态（`await next()`）；宿主已经决定重试就尊重它，
 *   宿主放弃时才轮到我这条闸。这样不会和宿主的退避逻辑打架。
 *
 * 判据全部是数据（`permanent` 码表 + `max` 预算），代码里不硬编码错误码。
 */
export const name = 'forge-request-retry'

/** 标准 HTTP 语义里属于「重试也没用」的状态码。 */
const PERMANENT_STATUS = new Set([400, 401, 403, 404, 405, 409, 422])

/** 码名兜底：不依赖具体供应商，只看名字里的语义。 */
const PERMANENT_CODE = /AUTH|INVALID|PERMISSION|FORBIDDEN|NOT_FOUND|UNSUPPORTED|CONTENT_POLICY/i

/**
 * 纯判决：返回 `{ kind: 'retry' }` 或 `undefined`。
 * @param payload  agent/request-error 的载荷
 * @param config   { enabled, max, permanent: string[] }
 * @param attempts 本 (agent, turn, step) 已重试次数
 */
export function decide(payload, config = {}, attempts = 0) {
  if (config?.enabled === false) return undefined
  if (payload?.signal?.aborted) return undefined

  const max = Number.isFinite(config?.max) ? Number(config.max) : 2
  if (attempts >= max) return undefined

  const failure = payload?.failure ?? {}
  const code = String(failure.code ?? '')
  const status = Number.isFinite(failure.status) ? Number(failure.status) : undefined

  const permanent = Array.isArray(config?.permanent) ? config.permanent : []
  if (permanent.some((p) => String(p).toUpperCase() === code.toUpperCase())) return undefined
  if (status !== undefined && PERMANENT_STATUS.has(status)) return undefined
  if (PERMANENT_CODE.test(code)) return undefined

  // 供应商要求的等待时间交给宿主退避；这里只表态「值得再试一次」。
  return { kind: 'retry' }
}

export function apply(ctx, config = {}) {
  const attempts = new Map()
  const log = []
  const record = (line) => {
    log.push({ at: new Date().toISOString(), ...line })
    if (log.length > 100) log.shift()
  }
  const keyOf = (payload) => `${payload?.agent?.id ?? ''}:${payload?.turn ?? 0}:${payload?.step ?? 0}`

  try {
    ctx.effect(
      () =>
        ctx.on('agent/request-error', async (payload, next) => {
          const host = await next()
          // 宿主已经决定重试（或做了别的处置），不抢它的决定。
          if (host) return host

          const key = keyOf(payload)
          const used = attempts.get(key) ?? 0
          const decision = decide(payload, config, used)
          if (!decision) return host

          attempts.set(key, used + 1)
          if (attempts.size > 200) attempts.delete(attempts.keys().next().value)
          record({ op: 'retry', key, code: String(payload?.failure?.code ?? ''), attempt: used + 1 })
          return decision
        }),
      'forge.request-retry.request-error()',
    )
  } catch (error) {
    record({ op: 'error', note: String(error?.message || error) })
  }

  return { journal: () => log.slice(-20) }
}

export default { name, apply }
