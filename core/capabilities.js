/**
 * L0 能力表 —— 把「宿主权限相关的一切」做成**统一参数**。
 *
 * 设计原则：不替用户决定要不要，只决定**怎么安全地做**。
 * 每项能力都声明自己的 `cost`，成本越高，前置闸越多：
 *
 *   native        走官方扩展点，零副作用，可随时开合
 *   env           改进程环境变量，进程级、可还原
 *   filesystem    动本机文件/计划任务，必须自带 backup + revert
 *   source-patch  改宿主源码，必须过 core/patch.js 的六道闸，且默认总闸关闭
 *
 * 加一项能力 = 往这张表加一行。不需要改 index.js。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { applyPatch, revertPatch, resolveAiBase, hostVersion } from './patch.js'

export const COST_LEVELS = Object.freeze({
  native: '官方扩展点，零副作用',
  env: '进程环境变量，可还原',
  filesystem: '本机文件 / 计划任务，自带备份与还原',
  'source-patch': '宿主源码，需版本锁定 + 语法校验 + 自动回滚',
})

/** 备份根目录。所有 filesystem 成本的改动都落在这里，便于一处清理。 */
export function backupRoot(dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  return path.join(dshHome, 'dsh-forge', 'backup')
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function run(bin, args) {
  try {
    const out = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    return { ok: out.status === 0, stdout: String(out.stdout || ''), stderr: String(out.stderr || ''), status: out.status }
  } catch (error) {
    return { ok: false, stdout: '', stderr: String(error?.message || error), status: -1 }
  }
}

/* ------------------------------------------------------------------ DSH Doctor */

const DOCTOR_TASK = 'DSH Doctor Supervisor'

function doctorPaths(env = process.env) {
  const local = env.LOCALAPPDATA || ''
  const dir = local ? path.join(local, 'DSH Doctor') : ''
  return {
    dir,
    files: ['supervisor.cmd', 'supervisor.vbs'].map((name) => (dir ? path.join(dir, name) : '')).filter(Boolean),
  }
}

/* ------------------------------------------------------------------ 能力表 */

export const CAPABILITIES = Object.freeze({
  'auto-approve': {
    cost: 'native',
    default: false,
    title: '审批自动放行',
    detail: 'approval/request → allowed-once。走官方 waterfall，approval/asked + approval/decided 审计对仍完整落盘。',
    apply({ ctx, journal }) {
      const dispose = ctx.on('approval/request', () => 'allowed-once', { global: true, prepend: true })
      journal?.record({ layer: 'L0', id: 'auto-approve', op: 'install', note: 'approval/request → allowed-once' })
      return { status: 'installed', disposers: [dispose] }
    },
  },

  'scrub-permission-env': {
    cost: 'env',
    default: false,
    title: '清除 DSH_PERMISSION_MODE',
    detail: '宿主会读这个环境变量当权限默认值。清掉等于回到「由 UI / 配置决定」，revert 可写回。',
    apply({ journal }) {
      const prev = process.env.DSH_PERMISSION_MODE
      if (prev === undefined) return { status: 'not-set', detail: '本来就没设置' }
      delete process.env.DSH_PERMISSION_MODE
      journal?.record({ layer: 'L0', id: 'scrub-permission-env', op: 'install', note: `was ${prev}` })
      return {
        status: 'installed',
        disposers: [
          () => {
            process.env.DSH_PERMISSION_MODE = prev
          },
        ],
      }
    },
  },

  'remove-doctor-supervisor': {
    cost: 'filesystem',
    default: false,
    title: '移除 DSH Doctor 守护脚本与计划任务',
    detail:
      'purge 的 stubDoctorSupervisor 会删这两个文件 + 计划任务，但不留备份。本实现先导出任务 XML、复制脚本到 backup/，再删，可用 revert 完全还原。',
    apply({ journal, dshHome }) {
      if (process.platform !== 'win32') return { status: 'skipped', detail: '仅 Windows' }

      const { files } = doctorPaths()
      const root = path.join(backupRoot(dshHome), `doctor-${stamp()}`)
      const manifest = { at: new Date().toISOString(), dir: root, files: [], taskXml: '', taskExisted: false }
      const touched = []

      try {
        const query = run('schtasks', ['/Query', '/TN', DOCTOR_TASK, '/XML'])
        if (query.ok && query.stdout.includes('<')) {
          fs.mkdirSync(root, { recursive: true })
          manifest.taskXml = path.join(root, 'task.xml')
          fs.writeFileSync(manifest.taskXml, query.stdout, 'utf8')
          manifest.taskExisted = true
        }

        for (const file of files) {
          if (!fs.existsSync(file)) continue
          fs.mkdirSync(root, { recursive: true })
          const dest = path.join(root, path.basename(file))
          fs.copyFileSync(file, dest)
          manifest.files.push({ from: file, to: dest })
          fs.unlinkSync(file)
          touched.push(path.basename(file))
        }

        if (manifest.taskExisted) {
          const del = run('schtasks', ['/Delete', '/TN', DOCTOR_TASK, '/F'])
          if (!del.ok) throw new Error(`schtasks /Delete 失败：${del.stderr || del.stdout}`)
          touched.push(`task:${DOCTOR_TASK}`)
        }

        if (touched.length === 0) return { status: 'not-found', detail: '没有找到守护脚本或计划任务' }

        fs.mkdirSync(root, { recursive: true })
        fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        journal?.record({ layer: 'L0', id: 'remove-doctor-supervisor', op: 'install', note: touched.join(', ') })
        return { status: 'installed', detail: `已移除 ${touched.join(', ')}，备份在 ${root}`, manifest: root }
      } catch (error) {
        return { status: 'error', detail: String(error?.message || error), manifest: root }
      }
    },
    revert({ journal, dshHome }) {
      const root = path.join(backupRoot(dshHome))
      let dirs = []
      try {
        dirs = fs
          .readdirSync(root)
          .filter((name) => name.startsWith('doctor-'))
          .sort()
          .reverse()
      } catch {
        return { status: 'no-backup', detail: '没有备份目录' }
      }
      for (const name of dirs) {
        const manifestPath = path.join(root, name, 'manifest.json')
        if (!fs.existsSync(manifestPath)) continue
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
          for (const item of manifest.files || []) {
            if (fs.existsSync(item.to)) fs.copyFileSync(item.to, item.from)
          }
          if (manifest.taskExisted && manifest.taskXml && fs.existsSync(manifest.taskXml)) {
            run('schtasks', ['/Create', '/TN', DOCTOR_TASK, '/XML', manifest.taskXml, '/F'])
          }
          journal?.record({ layer: 'L0', id: 'remove-doctor-supervisor', op: 'revert', note: name })
          return { status: 'reverted', detail: `已从 ${name} 还原` }
        } catch (error) {
          return { status: 'error', detail: String(error?.message || error) }
        }
      }
      return { status: 'no-backup', detail: '备份里没有 manifest.json' }
    },
  },

  'suppress-host-crash': {
    cost: 'source-patch',
    default: false,
    title: '宿主退出静默（不弹 crash 框）',
    detail: '需要宿主源码补丁（desktop-shell 的退出分支）。补丁未定义或版本不匹配时本项自动跳过。',
    patches: ['desktop-shell-silent-exit'],
  },

  'escalation-ladder-bypass': {
    cost: 'source-patch',
    default: false,
    title: 'escalation 加宽阶梯豁免',
    detail:
      'sandbox 包里的严格加宽校验是模块级函数，没有对外扩展点，只能改源码。通常不需要：把 sandboxPolicy.mode 设成 danger-full-access 就不会走到 escalation。',
    patches: ['sandbox-escalation-widening-exempt'],
  },
})

export const CAPABILITY_IDS = Object.freeze(Object.keys(CAPABILITIES))

/**
 * 安装能力。
 *
 * @param {object} deps
 * @param {object} deps.ctx
 * @param {object} deps.config  resolveConfig 的结果
 * @param {import('./journal.js').Journal} deps.journal
 * @param {object[]} deps.patches 源码补丁目录（patches/catalog.js）
 * @param {boolean} [deps.applySourcePatches] 是否真的改宿主源码（只有 CLI 给 true）
 * @param {boolean} [deps.applyDestructive] 是否真的执行 filesystem 成本操作（只有 CLI + --destructive 给 true）
 */
export function installCapabilities({
  ctx,
  config,
  journal,
  patches = [],
  applySourcePatches = false,
  applyDestructive = false,
}) {
  const results = []
  const disposers = []
  const wants = config?.l0?.capabilities || {}
  const sourcePatchOn = config?.l0?.sourcePatch?.enabled === true

  for (const [id, cap] of Object.entries(CAPABILITIES)) {
    const enabled = wants[id] === true
    if (!enabled) {
      results.push({ id, cost: cap.cost, enabled: false, status: 'off' })
      continue
    }

    if (cap.cost === 'source-patch') {
      if (!sourcePatchOn) {
        results.push({ id, cost: cap.cost, enabled: true, status: 'blocked', detail: 'l0.sourcePatch.enabled 未开启' })
        continue
      }
      const aiBase = resolveAiBase()
      const version = hostVersion(aiBase)
      const ids = Array.isArray(cap.patches) ? cap.patches : []
      const found = patches.filter((p) => ids.includes(p.id))
      if (found.length === 0) {
        results.push({
          id,
          cost: cap.cost,
          enabled: true,
          status: 'no-definition',
          detail: `patches/catalog.js 里没有 ${ids.join(', ')}`,
        })
        continue
      }
      const detail = []
      let failed = false
      for (const patch of found) {
        const result = applyPatch(patch, aiBase, { version, dryRun: !applySourcePatches })
        detail.push(`${patch.id}:${result.status}${result.reason ? `(${result.reason})` : ''}`)
        if (!result.ok && result.status !== 'already') failed = true
      }
      results.push({
        id,
        cost: cap.cost,
        enabled: true,
        status: failed ? 'failed' : applySourcePatches ? 'installed' : 'preview-ok',
        detail: detail.join('; '),
      })
      continue
    }

    // filesystem 成本会动本机文件 / 计划任务 —— 宿主运行时永不执行，只能 CLI --destructive。
    if (cap.cost === 'filesystem' && !applyDestructive) {
      results.push({
        id,
        cost: cap.cost,
        enabled: true,
        status: 'blocked',
        detail: 'filesystem 成本，需 CLI 加 --destructive 执行',
      })
      continue
    }

    try {
      const out = cap.apply?.({ ctx, journal, config, dshHome: config?.dshHome }) || { status: 'noop' }
      if (Array.isArray(out.disposers)) disposers.push(...out.disposers)
      results.push({ id, cost: cap.cost, enabled: true, status: out.status, detail: out.detail })
    } catch (error) {
      results.push({ id, cost: cap.cost, enabled: true, status: 'error', detail: String(error?.message || error) })
    }
  }

  return { results, disposers }
}

/** 回滚某个 filesystem 成本的能力（CLI 用）。 */
export function revertCapability(id, { journal, dshHome }) {
  const cap = CAPABILITIES[id]
  if (!cap) return { status: 'unknown-capability', detail: id }
  if (typeof cap.revert !== 'function') return { status: 'no-revert', detail: `${id} 不需要回滚（cost=${cap.cost}）` }
  return cap.revert({ journal, dshHome })
}

/** 状态表：声明 + 当前开关 + 成本。 */
export function describeCapabilities(config) {
  const wants = config?.l0?.capabilities || {}
  const sourcePatchOn = config?.l0?.sourcePatch?.enabled === true
  return CAPABILITY_IDS.map((id) => ({
    id,
    title: CAPABILITIES[id].title,
    detail: CAPABILITIES[id].detail,
    cost: CAPABILITIES[id].cost,
    costLabel: COST_LEVELS[CAPABILITIES[id].cost],
    enabled: wants[id] === true,
    needsSourcePatch: CAPABILITIES[id].cost === 'source-patch',
    available: CAPABILITIES[id].cost !== 'source-patch' || sourcePatchOn,
    hasRevert: typeof CAPABILITIES[id].revert === 'function',
  }))
}
