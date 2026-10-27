/**
 * L0 建议项 —— 「宿主本来就能配，不需要打补丁」的那一类。
 *
 * purge 用源码补丁改了 4 个其实在 config 里的东西（#21/#22/#23/#24）。
 * 打补丁的代价是版本一升就碎；正确做法是把它当配置项展示出来，让用户自己设。
 *
 * 本模块**只读**：
 *   · 能从宿主服务读到的，读出来（sandbox/approval/systemPrompt）
 *   · 读不到的，只给「怎么改」的路径，不猜当前值
 *
 * 每一条都标注了来源（宿主哪个包、哪个 Config 字段），可自行核对。
 */

/** 静态建议表。current(ctx) 返回 null 表示"当前拿不到，只能告诉你怎么改"。 */
export const ADVICE = Object.freeze([
  {
    id: 'sandbox-mode',
    title: '沙箱默认模式',
    source: 'dsh-sandbox-policy · Config.mode',
    values: ['read-only', 'workspace-write', 'danger-full-access'],
    how: 'cordis.patch.yml: - id: sandbox-policy, config: { mode: danger-full-access }',
    note: '设成 danger-full-access 后不会触发 escalation，也不需要审批。',
    current(ctx) {
      try {
        const policy = ctx?.get?.('sandboxPolicy')
        return policy?.defaultMode ?? null
      } catch {
        return null
      }
    },
  },
  {
    id: 'approval-policy',
    title: '审批策略',
    source: 'dsh-user-approval · Config.policy',
    values: ['ask', 'never'],
    how: 'cordis.patch.yml: - id: user-approval, config: { policy: ask }',
    note: '注意 never 的语义是「不问、直接拒」，不是「自动放行」。自动放行走本插件的 auto-approve 能力。',
    current(ctx) {
      try {
        return ctx?.get?.('approval')?.config?.policy ?? null
      } catch {
        return null
      }
    },
  },
  {
    id: 'harness-identity',
    title: '宿主身份句',
    source: 'dsh-system-prompt · Config.includeHarnessIdentity',
    values: ['true', 'false'],
    how: 'cordis.patch.yml: - id: system-prompt, config: { includeHarnessIdentity: false }',
    note: '本插件默认已用 L1 的 stripSections 剔除该段，无需再改 config。',
    current() {
      return null
    },
  },
  {
    id: 'read-caps',
    title: '文件读取上限',
    source: 'dsh-tool-fs · Config.readLimit / readMaxLineLength / readMaxBytes',
    values: ['正整数'],
    how: 'cordis.patch.yml: - id: tool-fs, config: { readLimit: 4000, readMaxBytes: 2000000 }',
    note: 'purge 的 #22 是打补丁改这组值；这里直接配即可。',
    current() {
      return null
    },
  },
  {
    id: 'subagent-depth',
    title: '子代理嵌套深度',
    source: 'dsh-tool-subagent · Config.maxDepth',
    values: ['自然数', 'provider-managed'],
    how: 'cordis.patch.yml: - id: tool-subagent, config: { maxDepth: 3 }',
    note: 'purge 的 #23 是打补丁改这个；这里是纯配置。',
    current() {
      return null
    },
  },
  {
    id: 'shell-timeout',
    title: '持久 shell 超时',
    source: '预设 YAML 里的 timeoutMs（不是工具 Config）',
    values: ['毫秒'],
    how: '预设的 persistent-pwsh / persistent-bash 段：config: { timeoutMs: 300000 }',
    note: '这条确实在预设 YAML 而非工具 config 里，purge 的 #21 打的就是它。改预设不用改宿主源码。',
    current() {
      return null
    },
  },
])

/** 生成建议表：能给当前值就给，给不了标 null。 */
export function adviceReport(ctx = null) {
  return ADVICE.map((item) => {
    let current = null
    try {
      current = item.current(ctx)
    } catch {
      current = null
    }
    return {
      id: item.id,
      title: item.title,
      source: item.source,
      values: item.values,
      current,
      how: item.how,
      note: item.note,
    }
  })
}
