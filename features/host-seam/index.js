/**
 * forge.host-seam —— L0 层：用宿主已有的瀑布口子达成「改宿主」的效果。
 *
 * 这一层和别的模块不同：
 *   · 默认关闭（`enabled: false`），开了也不需要重启之外的仪式 —— 但要重启。
 *   · 它影响的是**全局**，不是锻造模式。`fs/write-intent` / `fs/edit-intent`
 *     这两条事件没有作用域派发，注册上去就是所有会话一起生效。
 *     这是 L0 的固有属性，不是实现偷懒 —— 所以它必须显式打开。
 *
 * 为什么这两条能等价于 purge 的 #17（写 host 文件让 intent 返回 void）：
 *   宿主 fs-observation-policy 在 `fs/write-intent` 上 claim 判决且**从不调 next**，
 *   所以排在它前面并直接返回 `undefined`，等于读版本 / 先读后写 / 不存在校验
 *   整套不存在 —— 与「这个插件根本没装」逐位等价。
 *   而我们一个字节的宿主文件都没改：撤掉这一行配置就完全还原。
 *
 * 用法（取消注释、改 true、重启）：
 *   config:
 *     enabled: true
 *     writeIntentFree: true
 *     editIntentFree: true
 */

export const name = 'forge-host-seam'

/** 返回 undefined 的判决 = 「没有前置条件」，让裸 provider 无条件写。 */
const NO_INTENT = () => undefined

export function mount(ctx, config = {}) {
  const log = []
  const record = (line) => {
    log.push({ at: new Date().toISOString(), ...line })
    if (log.length > 50) log.shift()
  }

  if (config.enabled !== true) {
    record({ op: 'skip', note: 'enabled 不是 true，L0 层不注册任何监听器' })
    return { enabled: false, journal: () => log.slice(-20) }
  }

  const claims = []
  const claim = (event, on) => {
    if (on === false) return
    try {
      ctx.effect(
        () =>
          ctx.on(
            event,
            // 不调 next：宿主的闸就在下游，放它进来就等于没关。
            NO_INTENT,
            // prepend 不是优化，是正确性：宿主自己在 boot 时就注册了这道闸。
            { prepend: true },
          ),
        `forge.host-seam.${event}()`,
      )
      claims.push(event)
    } catch (error) {
      record({ op: 'error', event, note: String(error?.message || error) })
    }
  }

  claim('fs/write-intent', config.writeIntentFree)
  claim('fs/edit-intent', config.editIntentFree)

  record({ op: 'mount', claims })
  return { enabled: true, claims, journal: () => log.slice(-20) }
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
