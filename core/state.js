/**
 * 运行时总开关。
 *
 * 落盘在 `$DSH_HOME/dsh-forge/state.json`，与 cordis 配置分开：
 *   · 配置（cordis.patch.yml）属于「结构」，改它要重启
 *   · 开关属于「此刻要不要生效」，运行时切，立即起作用
 *
 * 状态文件不存在 = 关（返回 enabled:false）。UI 上那个 iOS 开关直接反映它。
 *
 * 为什么不是纯 UI 开关：UI 只隐藏面板没有意义。关掉必须让**四层改写和效果一起停**，
 * 否则用户以为关了、其实提示词还在注入。
 *
 * 读取带 500ms TTL 缓存 —— 每步会问好几次，不做缓存就是每步若干次 stat。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TTL_MS = 500
const cache = new Map()

export function stateDir(dshHome) {
  return path.join(dshHome, 'dsh-forge')
}

export function statePath(dshHome) {
  return path.join(stateDir(dshHome), 'state.json')
}

function realHome(dshHome) {
  return dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * 读开关状态。
 *
 * **默认关**：文件不存在就返回 enabled:false —— 装上插件不等于立刻改行为，
 * 要用户在输入框那一行的 iOS 开关上显式打开（或 `forge switch on`）。
 *
 * @returns {{enabled:boolean, at:string|null, exists:boolean}}
 */
export function readState(dshHome, now = Date.now()) {
  const home = realHome(dshHome)
  const file = statePath(home)
  const hit = cache.get(file)
  if (hit && now - hit.at < TTL_MS) return hit.value

  let value = { enabled: false, at: null, exists: false }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    value = {
      enabled: raw?.enabled === true,
      at: typeof raw?.at === 'string' ? raw.at : null,
      exists: true,
    }
  } catch {
    /* 文件不存在或损坏 → 视为开，不让坏文件把功能锁死 */
  }
  cache.set(file, { at: now, value })
  return value
}

/** 写开关状态（原子：tmp + rename）。 */
export function writeState(dshHome, patch = {}) {
  const home = realHome(dshHome)
  const file = statePath(home)
  const current = readState(home)
  const next = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    at: new Date().toISOString(),
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  cache.delete(file)
  return { ...next, exists: true }
}

export function setEnabled(dshHome, enabled) {
  return writeState(dshHome, { enabled: !!enabled })
}

/**
 * 综合判定：配置允许 + 用户开关打开。
 * 任何一处关掉都视为不生效。
 */
export function isEnabled(dshHome, config) {
  if (config?.enabled === false) return false
  return readState(dshHome).enabled !== false
}

export function clearCache() {
  cache.clear()
}
