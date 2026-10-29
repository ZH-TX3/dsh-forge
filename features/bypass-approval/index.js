/**
 * forge.bypass-approval —— 授信旁路。
 *
 * 落点：`approval/request` 瀑布。宿主说明：waterfall + **agent 作用域派发**，
 * 返回一个 outcome 即接管该请求，`next()` 表示让给后面的 answerer。
 *
 * 所以「无条件授信」不需要动宿主一个字节：在锻造模式的作用域里，
 * 本监听器排在 UI answerer 前面，直接返回 `allowed-once`。
 *
 * 判据是数据，不是代码：`allow` 里是工具名通配符列表，空数组 = 全放。
 * 不在列表里的请求一律 `next()`，交回宿主原来的（人工）判定。
 *
 * 唯一被授予的结果是 `'allowed-once'` —— 宿主明确写着这是唯一 grant，
 * 不复用、不缓存、不跨请求生效。
 *
 * ⚠ 别设 `policy = 'never'`：宿主的 never 分支在 `decide()` 里先于 waterfall
 * 返回 'rejected'（那是 fail-closed 承诺的一部分），本监听器根本收不到请求。
 * 所以本功能的前提是会话 policy 为默认的 'ask'。用户把会话切到 never 时，
 * 授信会静默失效 —— 这是宿主语义，不是本插件的 bug。
 */
export const name = 'forge-bypass-approval'
// 不 inject services：本模块只注册监听器，不调用 approval 的任何方法。
// （Cordis 的 inject 只有「数组」和「name → config map」两种形式；
//   写成 { required, optional } 会被当成要等两个叫 required/optional 的服务，
//   预设因此永远停在 "waiting for required, optional"。）
export const inject = []

const GRANT = 'allowed-once'

/** 通配符匹配：`*` 任意串，`?` 单字符。不区分大小写。 */
export function matches(pattern, value) {
  const p = String(pattern).toLowerCase()
  const v = String(value).toLowerCase()
  if (p === '*') return true
  const rx = new RegExp(
    `^${p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
  )
  return rx.test(v)
}

/**
 * 纯函数判决：返回 outcome 表示接管，返回 null 表示交给后面的 answerer。
 * 导出是为了能离线断言（不需要真 Agent）。
 */
export function decide(config, req) {
  if (config?.enabled === false) return null
  const allow = Array.isArray(config?.allow) ? config.allow : []
  const toolName = req?.toolName ?? ''
  if (allow.length === 0) return GRANT
  return allow.some((pattern) => matches(pattern, toolName)) ? GRANT : null
}

export function mount(ctx, config = {}) {
  const log = []
  const record = (line) => {
    log.push({ at: new Date().toISOString(), ...line })
    if (log.length > 100) log.shift()
  }

  try {
    ctx.effect(
      () =>
        ctx.on('approval/request', async (req, next) => {
          const outcome = decide(config, req)
          if (outcome === null) return next()
          record({ op: 'grant', tool: req?.toolName ?? '', reason: req?.reason ?? '' })
          return outcome
        }),
      'forge.bypass-approval.request()',
    )
  } catch (error) {
    // 自兜底：不因为这一条把整个预设拖下水。
    record({ op: 'error', note: String(error?.message || error) })
  }

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

export default { name, inject, apply }
