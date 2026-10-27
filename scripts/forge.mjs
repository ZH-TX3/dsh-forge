#!/usr/bin/env node
/**
 * dsh-forge 离线工装。
 *
 * 凡事会**改变宿主状态**的操作都只能从这里执行 —— 宿主运行时不写源码、
 * 不动计划任务、不改会话文件。这是本项目的核心承诺，不是可选项。
 *
 *   node scripts/forge.mjs cap list
 *   node scripts/forge.mjs cap apply <id> [--destructive]
 *   node scripts/forge.mjs cap revert <id>
 *
 *   node scripts/forge.mjs patch list
 *   node scripts/forge.mjs patch preview <id>
 *   node scripts/forge.mjs patch apply <id>
 *   node scripts/forge.mjs patch revert <id>
 *
 *   node scripts/forge.mjs update check
 *   node scripts/forge.mjs update apply [--dry-run]
 *
 *   node scripts/forge.mjs session list
 *   node scripts/forge.mjs session stat <file>
 *   node scripts/forge.mjs session redact <file> --pattern <re> [--apply]
 *
 * 配置来源：$DSH_HOME/dsh-forge/config.json（与 cordis.patch.yml 的 config 同形状），
 * 再叠加 DSH_FORGE_* 环境变量。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../core/config.js'
import { Journal } from '../core/journal.js'
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  describeCapabilities,
  installCapabilities,
  revertCapability,
} from '../core/capabilities.js'
import { PATCHES, isDefined, patchById } from '../patches/catalog.js'
import { applyPatch, hostVersion, previewPatch, reportPatches, resolveAiBase, revertPatch } from '../core/patch.js'
import { applyUpdate, checkUpdate, computeArchiveHash, localVersion, updateSettings } from '../core/update.js'
import { spawnSync } from 'node:child_process'
import { listSessions, readSession, redactSession, restoreSession, statSession } from '../core/l4.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const positional = args.filter((a) => !a.startsWith('--'))

function flagValue(name, fallback = '') {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}

function loadConfig() {
  let file = {}
  const fp = path.join(DSH_HOME, 'dsh-forge', 'config.json')
  try {
    file = JSON.parse(fs.readFileSync(fp, 'utf8'))
  } catch {
    file = {}
  }
  return resolveConfig(file, process.env)
}

function print(rows) {
  for (const row of rows) console.log(row)
}

function pad(text, width) {
  const s = String(text ?? '')
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

/* ------------------------------------------------------------------ cap */

function capList(config) {
  const rows = describeCapabilities(config).map((cap) =>
    [
      pad(cap.enabled ? '[on] ' : '[  ] ', 6),
      pad(cap.id, 28),
      pad(cap.cost, 14),
      cap.needsSourcePatch && !config.l0.sourcePatch.enabled ? '需要 l0.sourcePatch.enabled' : cap.costLabel,
    ].join(' '),
  )
  print(['能力                    成本            说明', ...rows])
  console.log(`\nsourcePatch 总闸: ${config.l0.sourcePatch.enabled ? '开' : '关'}`)
}

function capApply(config, id) {
  const cap = CAPABILITIES[id]
  if (!cap) throw new Error(`未知能力：${id}（可选：${CAPABILITY_IDS.join(', ')}）`)

  if (cap.cost === 'source-patch') {
    if (!config.l0.sourcePatch.enabled) throw new Error('l0.sourcePatch.enabled 未开启，拒绝改宿主源码')
    const aiBase = requireAiBase()
    const version = hostVersion(aiBase)
    const found = PATCHES.filter((p) => (cap.patches || []).includes(p.id))
    if (found.length === 0) throw new Error(`patches/catalog.js 里没有 ${(cap.patches || []).join(', ')}`)
    for (const patch of found) {
      if (!isDefined(patch)) {
        console.log(`- ${patch.id}: 未定义（draft）。先跑 patch draft 拿到候选片段再填。`)
        continue
      }
      const result = applyPatch(patch, aiBase, { version })
      console.log(`${result.ok ? '✓' : '✗'} ${patch.id}: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`)
      if (result.bak) console.log(`    备份 ${result.bak}`)
    }
    return
  }

  const destructive = has('--destructive')
  if (cap.cost === 'filesystem' && !destructive) {
    throw new Error('filesystem 成本的操作需要 --destructive 显式确认')
  }

  // 统一走 installCapabilities，保证 CLI 与宿主走同一套闸。
  const { results } = installCapabilities({
    ctx: null,
    config: { ...config, l0: { ...config.l0, capabilities: { [id]: true } } },
    journal: new Journal(),
    patches: PATCHES.filter(isDefined),
    applySourcePatches: true,
    applyDestructive: destructive,
  })
  const out = results.find((r) => r.id === id)
  console.log(`${out?.status}: ${out?.detail || ''}`)
}

function capRevert(config, id) {
  const out = revertCapability(id, { journal: new Journal(), dshHome: DSH_HOME })
  console.log(`${out.status}: ${out.detail || ''}`)
}

/* ------------------------------------------------------------------ patch */

function requireAiBase() {
  const aiBase = resolveAiBase()
  if (!aiBase) throw new Error('未找到宿主 @deepseek-ai 目录（可用 DSH_FORGE_AIBASE 指定）')
  return aiBase
}

function patchList() {
  const aiBase = requireAiBase()
  const version = hostVersion(aiBase)
  console.log(`宿主 ${version} @ ${aiBase}\n`)
  for (const row of reportPatches(PATCHES.filter(isDefined), aiBase, version)) {
    console.log(`${row.ok ? '✓' : '✗'} ${pad(row.id, 40)} ${pad(row.status, 22)} ${row.reason || ''}`)
  }
  const drafts = PATCHES.filter((p) => !isDefined(p))
  if (drafts.length) console.log(`\n未定义（draft）: ${drafts.map((p) => p.id).join(', ')}`)
}

function patchPreview(id) {
  const patch = patchById(id)
  if (!patch) throw new Error(`未知补丁：${id}`)
  const aiBase = requireAiBase()
  const result = previewPatch(patch, aiBase)
  console.log(`status: ${result.status}`)
  console.log(`reason: ${result.reason}`)
  if (result.diff) console.log(`\n${result.diff}`)
}

function patchApply(id) {
  const patch = patchById(id)
  if (!patch) throw new Error(`未知补丁：${id}`)
  const aiBase = requireAiBase()
  const result = applyPatch(patch, aiBase)
  console.log(`${result.ok ? '✓' : '✗'} ${result.status}${result.reason ? ` — ${result.reason}` : ''}`)
  if (result.bak) console.log(`备份 ${result.bak}`)
  if (result.shaBefore) console.log(`原文件 sha256 ${result.shaBefore}`)
}

function patchRevert(id) {
  const patch = patchById(id)
  if (!patch) throw new Error(`未知补丁：${id}`)
  const result = revertPatch(patch, requireAiBase())
  console.log(`${result.ok ? '✓' : '✗'} ${result.status}${result.reason ? ` — ${result.reason}` : ''}`)
}

/* ------------------------------------------------------------------ update */

/** 私有仓库需要 token。环境变量没有时借用本机 gh 的凭据（只读一次）。 */
function ghToken() {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return ''
  try {
    const out = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    return out.status === 0 ? String(out.stdout || '').trim() : ''
  } catch {
    return ''
  }
}

async function updateCmd(config, sub) {
  const settings = updateSettings(config)
  if (!settings.repo) throw new Error('未配置 update.repo')
  if (!settings.token) settings.token = ghToken()

  if (sub === 'check') {
    const info = await checkUpdate(settings)
    console.log(`仓库   ${info.repo}@${info.ref}`)
    console.log(`sha    ${info.sha}`)
    console.log(`远版本 ${info.remoteVersion || '(未知)'}   本地 ${localVersion(PLUGIN_ROOT) || '(未知)'}`)
    console.log(`钉住   ${info.pinned ? '是' : '否 —— apply 会被拒绝'}`)
    console.log(`认证   ${settings.token ? '已带 token' : '未带 token（私有仓库会 404）'}`)
    if (!info.pinned) console.log('\n要允许 apply，请把上面的 sha 对应的归档 sha256 写进 update.sha256')
    return
  }

  if (sub === 'pin') {
    const info = await computeArchiveHash(settings)
    console.log(`commit  ${info.sha}`)
    console.log(`归档    ${info.bytes} bytes`)
    console.log(`sha256  ${info.sha256}`)
    console.log('\n把下面这一段写进 cordis.patch.yml 的 update 段：')
    console.log(`  sha256: "${info.sha256}"`)
    return
  }

  if (sub === 'apply') {
    const result = await applyUpdate(settings, {
      targetDir: PLUGIN_ROOT,
      dryRun: has('--dry-run'),
      log: (line) => console.log(line),
    })
    console.log(result.dryRun ? `dry-run ok（${result.sha}）` : `已更新到 ${result.sha}，备份 ${result.backup}`)
    return
  }

  throw new Error('update 子命令：check | pin | apply')
}

/* ------------------------------------------------------------------ session */

function sessionCmd(sub, file) {
  const root = path.join(DSH_HOME, 'sessions')

  if (sub === 'list') {
    for (const item of listSessions(root)) {
      let info = ''
      try {
        info = `${statSession(item).events} events`
      } catch {
        info = '(读不了)'
      }
      console.log(`${info.padEnd(14)} ${item}`)
    }
    return
  }

  if (!file) throw new Error('需要会话文件路径')
  const target = path.resolve(file)

  if (sub === 'stat') {
    const stat = statSession(target)
    console.log(JSON.stringify(stat, null, 2))
    return
  }

  if (sub === 'redact') {
    const pattern = flagValue('--pattern')
    if (!pattern) throw new Error('需要 --pattern <正则>')
    const re = new RegExp(pattern, 'g')
    const result = redactSession(target, re, flagValue('--replacement', '[REDACTED]'), { dryRun: !has('--apply') })
    console.log(JSON.stringify(result, null, 2))
    if (result.dryRun) console.log('\n(dry-run：加 --apply 才写盘)')
    return
  }

  if (sub === 'restore') {
    console.log(JSON.stringify(restoreSession(target), null, 2))
    return
  }

  throw new Error('session 子命令：list | stat | redact | restore')
}

/* ------------------------------------------------------------------ main */

async function main() {
  const [group, sub, extra] = positional
  const config = loadConfig()

  if (!group || group === 'help' || has('--help') || has('-h')) {
    console.log(`dsh-forge 工装

  cap list | apply <id> [--destructive] | revert <id>
  patch list | preview <id> | apply <id> | revert <id>
  update check | pin | apply [--dry-run]
  session list | stat <file> | redact <file> --pattern <re> [--apply] | restore <file>

配置：$DSH_HOME/dsh-forge/config.json（与 cordis config 同形状）+ DSH_FORGE_* 环境变量
宿主运行时不会调用这里的任何写操作 —— 改宿主状态必须你亲自执行。`)
    return
  }

  if (group === 'cap') {
    if (sub === 'list' || !sub) return capList(config)
    if (sub === 'pin') {
    const info = await computeArchiveHash(settings)
    console.log(`commit  ${info.sha}`)
    console.log(`归档    ${info.bytes} bytes`)
    console.log(`sha256  ${info.sha256}`)
    console.log('\n把下面这一段写进 cordis.patch.yml 的 update 段：')
    console.log(`  sha256: "${info.sha256}"`)
    return
  }

  if (sub === 'apply') {
      if (!extra) throw new Error('需要能力 id')
      return capApply(config, extra)
    }
    if (sub === 'revert') {
      if (!extra) throw new Error('需要能力 id')
      return capRevert(config, extra)
    }
    throw new Error('cap 子命令：list | apply | revert')
  }

  if (group === 'patch') {
    if (sub === 'list' || !sub) return patchList()
    if (sub === 'preview') return patchPreview(extra)
    if (sub === 'apply') return patchApply(extra)
    if (sub === 'revert') return patchRevert(extra)
    throw new Error('patch 子命令：list | preview | apply | revert')
  }

  if (group === 'update') return updateCmd(config, sub || 'check')

  if (group === 'session') return sessionCmd(sub || 'list', extra)

  throw new Error(`未知命令：${group}`)
}

main().catch((error) => {
  console.error(`[forge] ${error?.message || error}`)
  process.exit(1)
})
