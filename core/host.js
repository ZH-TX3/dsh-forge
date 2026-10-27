/**
 * L0 —— 宿主策略基座。
 *
 * L0 是「基座」不是层：它不参与送给模型的数据改写，只影响宿主允许什么。
 *
 *   snapshot()       只读嗅探，永远安全，供状态页展示
 *
 * 会改变宿主权限行为的部分（含源码补丁）不在这里 —— 见 core/capabilities.js
 * 的统一能力表，那里每项都带成本等级与还原方式。
 *
 * 这里刻意与 purge 的做法不同：purge 用逐字字符串补丁改 @deepseek-ai 源码
 * （#6 deny→allow、#9 把审批链整段删掉、#15 confine 直通…），宿主一升级就碎，
 * 而且卸载后 .dshpurge.bak 是否还在全看运气。
 *
 * dsh-forge 只走官方扩展点：
 *   · 沙箱模式 / 审批默认值 → 属于宿主 config，本插件只「读出并建议」，不替用户改；
 *   · 审批放行 → 官方有 `approval/request` waterfall，直接返回 outcome 即可，
 *     `approval/asked` 与 `approval/decided` 审计对依然完整落盘（不破坏可审计性）。
 *   · escalation 加宽阶梯（sandbox 包内的模块级函数）没有对外扩展点。
 *     本插件**不**通过打源码来绕过它 —— 正确做法是把 sandboxPolicy.mode 设为
 *     danger-full-access，那样根本不会走到 escalation。
 */

/**
 * 只读快照。任何一项取不到都返回 null，不抛。
 * @returns {{sandboxMode:string|null, approvalPolicy:string|null, sessionSandboxMode:string|null}}
 */
export function snapshot(ctx, agent = null) {
  const out = { sandboxMode: null, approvalPolicy: null, sessionSandboxMode: null }

  try {
    const policy = ctx.get('sandboxPolicy')
    if (policy) {
      if (typeof policy.defaultMode === 'string') out.sandboxMode = policy.defaultMode
      const session = agent?.session
      if (session && typeof policy.resolve === 'function') {
        const resolved = policy.resolve({ session })
        if (resolved && typeof resolved.mode === 'string') out.sessionSandboxMode = resolved.mode
      }
    }
  } catch {
    /* 服务不存在或签名变了，留 null */
  }

  try {
    const approval = ctx.get('approval')
    const policy = approval?.config?.policy
    if (typeof policy === 'string') out.approvalPolicy = policy
  } catch {
    /* 同上 */
  }

  return out
}

/* 能力（含 danger 类）已迁到 core/capabilities.js 的统一能力表。
 * 本文件只保留只读嗅探 —— L0 的"读"和"写"分开放在两个文件里，避免误用。 */
