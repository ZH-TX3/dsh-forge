/**
 * 源码补丁引擎 —— 让「改写宿主源码」变成**数据 + 安全流程**，而不是一把梭。
 *
 * purge 的做法是 82 条逐字字符串补丁直接写盘：没有版本锁定、没有语法校验、
 * 没有 dry-run、没有哈希留痕。宿主一升级就 pattern_not_found 或半替换成语法错，
 * 唯一退路是碰运气的 .bak。这批能力本身有存在价值，问题出在流程。
 *
 * 本引擎把流程补齐，六道闸：
 *
 *   1. 总闸         l0.sourcePatch.enabled 默认 false
 *   2. 版本锁定     patch.hostVersions 必须包含当前宿主版本
 *   3. 存在性与幂等  目标文件在、marker 未写、find 串唯一命中
 *   4. dry-run      先出 diff，不写盘
 *   5. 写前留痕     记录原文件 sha256 + 生成 <file>.forge.bak（只建一次）
 *   6. 写后校验     `node --check` 临时文件；失败**自动回滚**
 *
 * 补丁本身是数据（patches/catalog.js），加一条补丁不需要改本文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

/** 宿主包根目录。只读探测，不做任何写入。 */
export function resolveAiBase(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const candidates = [
    env.DSH_FORGE_AIBASE,
    path.join(home, 'profiles', 'node_modules', '@deepseek-ai'),
    path.join(home, 'node_modules', '@deepseek-ai'),
  ].filter(Boolean)

  for (const dir of candidates) {
    try {
      if (fs.statSync(path.join(dir, 'dsh-agent-instructions', 'lib')).isDirectory()) return dir
    } catch {
      /* 下一个 */
    }
  }
  return ''
}

/** 宿主版本（读 dsh 包自己的 package.json）。取不到返回空串。 */
export function hostVersion(aiBase) {
  if (!aiBase) return ''
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(aiBase, 'dsh', 'package.json'), 'utf8'))
    return String(pkg.version || '')
  } catch {
    return ''
  }
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function sha256File(file) {
  try {
    return sha256(fs.readFileSync(file))
  } catch {
    return ''
  }
}

/**
 * 语法校验：把候选内容写到临时文件，跑 `node --check`。
 * 这是 purge 完全缺失的一道闸 —— 它写坏过宿主，用户只能重装。
 */
export function syntaxCheck(file, text) {
  const ext = path.extname(file) || '.js'
  const tmp = path.join(os.tmpdir(), `forge-check-${process.pid}-${Date.now()}${ext}`)
  try {
    fs.writeFileSync(tmp, text, 'utf8')
    const run = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    if (run.status === 0) return { ok: true }
    return { ok: false, error: String(run.stderr || run.stdout || 'syntax error').trim().split('\n').slice(0, 3).join('\n') }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 临时文件清理失败不影响结论 */
    }
  }
}

/** 逐行 diff（够看上下文就行，不引依赖）。 */
export function diffLines(before, after, context = 2) {
  const a = String(before).split('\n')
  const b = String(after).split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1

  const from = Math.max(0, head - context)
  const aEnd = Math.min(a.length, a.length - tail + context)
  const bEnd = Math.min(b.length, b.length - tail + context)
  const out = [`@@ -${from + 1},${aEnd - from} +${from + 1},${bEnd - from} @@`]
  for (let i = from; i < head; i += 1) out.push(`  ${a[i]}`)
  for (let i = head; i < a.length - tail; i += 1) out.push(`- ${a[i]}`)
  for (let i = head; i < b.length - tail; i += 1) out.push(`+ ${b[i]}`)
  for (let i = a.length - tail; i < aEnd; i += 1) out.push(`  ${a[i]}`)
  return out.join('\n')
}

/** 解析一条补丁的目标文件绝对路径。 */
export function targetPath(patch, aiBase) {
  if (!patch?.file) return ''
  return path.join(aiBase, ...String(patch.file).split('/'))
}

/**
 * 预检（不写盘）。返回 {ok, status, reason, diff, shaBefore}。
 * status: ok | no-aibase | version-mismatch | missing-file | no-definition
 *        | already | find-not-found | find-not-unique
 */
export function previewPatch(patch, aiBase, version = hostVersion(aiBase)) {
  if (!aiBase) return { ok: false, status: 'no-aibase', reason: '未找到宿主 @deepseek-ai 目录' }
  if (!patch?.find || typeof patch.replace !== 'string') {
    return { ok: false, status: 'no-definition', reason: '补丁缺少 find/replace' }
  }

  const want = Array.isArray(patch.hostVersions) ? patch.hostVersions : []
  if (want.length > 0 && !want.includes(version)) {
    return { ok: false, status: 'version-mismatch', reason: `宿主 ${version || '(未知)'} 不在白名单 ${want.join(', ')}` }
  }

  const file = targetPath(patch, aiBase)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { ok: false, status: 'missing-file', reason: `目标文件不存在：${file}` }
  }

  const shaBefore = sha256(text)
  if (patch.marker && text.includes(patch.marker)) {
    return { ok: true, status: 'already', reason: 'marker 已存在，视为已打', shaBefore, file }
  }

  const hits = text.split(patch.find).length - 1
  if (hits === 0) return { ok: false, status: 'find-not-found', reason: 'find 串未命中（宿主可能已升级）', shaBefore, file }
  if (hits > 1) return { ok: false, status: 'find-not-unique', reason: `find 串命中 ${hits} 处，拒绝模糊替换`, shaBefore, file }

  const next = text.replace(patch.find, patch.replace)
  const check = syntaxCheck(file, next)
  if (!check.ok) return { ok: false, status: 'syntax-error', reason: `替换后语法错误：${check.error}`, shaBefore, file }

  return { ok: true, status: 'ok', reason: '可应用', shaBefore, file, diff: diffLines(text, next), after: next }
}

/**
 * 应用一条补丁。
 * @param {object} patch
 * @param {string} aiBase
 * @param {{dryRun?:boolean, version?:string}} [opts]
 */
export function applyPatch(patch, aiBase, opts = {}) {
  const preview = previewPatch(patch, aiBase, opts.version)
  if (preview.status === 'already') return { ...preview, applied: false }
  if (!preview.ok) return { ...preview, applied: false }
  if (opts.dryRun) return { ...preview, applied: false, dryRun: true }

  const bak = `${preview.file}.forge.bak`
  try {
    // 只建一次：已存在的 bak 视为"上一次的原始基线"，不要覆盖掉真正的原件。
    if (!fs.existsSync(bak)) fs.copyFileSync(preview.file, bak)
    fs.writeFileSync(preview.file, preview.after, 'utf8')
  } catch (error) {
    return { ...preview, ok: false, status: 'write-error', reason: String(error?.message || error), applied: false }
  }

  // 写后复核：万一落盘被安全软件改写，再验一次。
  const verify = syntaxCheck(preview.file, fs.readFileSync(preview.file, 'utf8'))
  if (!verify.ok) {
    try {
      fs.copyFileSync(bak, preview.file)
    } catch {
      /* 回滚失败时把 bak 路径报出去 */
    }
    return { ...preview, ok: false, status: 'verify-failed-rolled-back', reason: verify.error, applied: false, bak }
  }

  return { ...preview, ok: true, applied: true, bak, shaAfter: sha256File(preview.file) }
}

/** 回滚一条补丁。 */
export function revertPatch(patch, aiBase) {
  const file = targetPath(patch, aiBase)
  const bak = `${file}.forge.bak`
  if (!fs.existsSync(bak)) return { ok: false, status: 'no-backup', reason: `没有备份：${bak}` }
  try {
    fs.copyFileSync(bak, file)
    fs.unlinkSync(bak)
    return { ok: true, status: 'reverted', file }
  } catch (error) {
    return { ok: false, status: 'revert-failed', reason: String(error?.message || error) }
  }
}

/** 批量预检整个目录（状态页用）。 */
export function reportPatches(patches, aiBase, version = hostVersion(aiBase)) {
  return (Array.isArray(patches) ? patches : []).map((patch) => {
    const result = previewPatch(patch, aiBase, version)
    return {
      id: patch.id,
      file: patch.file,
      ok: result.ok,
      status: result.status,
      reason: result.reason,
    }
  })
}
