/**
 * 源码补丁目录 —— **纯数据**。加一条补丁不需要改引擎，也不需要改 index.js。
 *
 * 每条补丁必须带：
 *   id           唯一
 *   file         相对宿主 @deepseek-ai 的路径
 *   hostVersions 宿主版本白名单（防止升级后误打，这是 purge 最缺的一道闸）
 *   marker       已打标记（幂等 + 状态报告）
 *   find         必须在文件里**唯一命中**，命中 0 或 >1 都拒绝
 *   replace      替换文本
 *
 * 安全流程（引擎自动做，见 core/patch.js）：
 *   dry-run 出 diff → 写前记 sha256 + 建 .forge.bak → 写入 → `node --check` → 失败自动回滚
 *
 * 两条铁律：
 *   1. **默认一律不启用**。要生效必须同时满足：能力开关为 true + l0.sourcePatch.enabled 为 true
 *      + 通过 CLI 显式执行（宿主运行时不写源码）。
 *   2. 手上有补丁不等于该打。升级宿主后先 `node scripts/forge.mjs patch list` 看状态。
 */

export const HOST_TARGET = '0.2.0-rc.2'

export const PATCHES = [
  /**
   * escalation 的「严格加宽阶梯」校验。
   *
   * 平时并不需要：把 sandboxPolicy.mode 设成 danger-full-access 就不会走到 escalation。
   * 只有当你想在 workspace-write / read-only 下也放行更宽的 sandbox_permissions 时才用。
   */
  {
    id: 'sandbox-escalation-widening-exempt',
    file: 'dsh-sandbox/lib/index.js',
    hostVersions: [HOST_TARGET],
    marker: '[dsh-forge] escalation widening exempt',
    find:
      '\tif (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call\'s current "${effectiveMode}" mode`);',
    replace:
      '\t/* [dsh-forge] escalation widening exempt */ if (false) throw new Error(`sandbox escalation widening is exempted by dsh-forge`);',
  },

  /**
   * 宿主退出静默（不弹 crash 框）。
   *
   * 这条故意留成 draft：不同构建的 desktop-shell 退出分支写法不一致，
   * 我不想给一条没验证过的 find 串让你在错误的前提下按下去。
   * 用 `node scripts/forge.mjs patch draft desktop-shell-silent-exit` 拿到当前文件的
   * 候选片段，确认后把 find/replace 填进来。
   */
  {
    id: 'desktop-shell-silent-exit',
    file: 'dsh-desktop-shell/lib/index.js',
    hostVersions: [HOST_TARGET],
    marker: '[dsh-forge] silent host exit',
    draft: true,
    find: '',
    replace: '',
  },
]

/** 按 id 取补丁。 */
export function patchById(id) {
  return PATCHES.find((patch) => patch.id === id) || null
}

/** 只有非 draft 且有 find/replace 的才算"已定义"。 */
export function isDefined(patch) {
  return Boolean(patch && !patch.draft && patch.find && typeof patch.replace === 'string')
}
