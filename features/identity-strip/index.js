/**
 * forge.identity-strip —— 身份行剥离。
 *
 * 落点：`systemPrompt.section()`，**同名覆盖**宿主全局段。
 * 宿主装配按名字合并：scoped 段覆盖 global 同名段（`NamedEntries` 语义）。
 * 所以只要用 `harness:identity` 这个名字注册空文本，那行
 * "You are an AI agent powered by DeepSeek Harness." 就没了。
 *
 * ⚠ 与 `forge-persona` 的 `complete: true` 互斥：
 *   complete 段在装配收尾会把 sections 收成单段，本段随之被丢掉。
 *   也就是说 —— persona 设了 complete 时，这条是无操作。
 *   要它生效，把 persona 的 complete 关掉，改用「本段 + 若干 section」的组合。
 *
 * 不需要动宿主源码，也不需要 purge 那种改常量的补丁。
 */
export const name = 'forge-identity-strip'
export const inject = ['systemPrompt']

const DEFAULT_TARGET = 'harness:identity'

export function apply(ctx, config = {}) {
  const log = []
  const record = (line) => {
    log.push({ at: new Date().toISOString(), ...line })
    if (log.length > 50) log.shift()
  }

  const target = typeof config.name === 'string' && config.name.trim() ? config.name.trim() : DEFAULT_TARGET
  const text = typeof config.text === 'string' ? config.text : ''

  try {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: target,
          order: Number.isFinite(config.order) ? Number(config.order) : 0,
          text,
          interpolate: false,
        }),
      'forge.identity-strip.section()',
    )
    record({ op: 'mount', target, bytes: Buffer.byteLength(text, 'utf8') })
  } catch (error) {
    record({ op: 'error', note: String(error?.message || error) })
  }

  return { target, journal: () => log.slice(-20) }
}

export default { name, inject, apply }
