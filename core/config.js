/**
 * 配置解析。
 *
 * 三次来源，后者覆盖前者：
 *   1. DEFAULTS（这里）
 *   2. cordis.patch.yml 的 config 段（宿主传进来的 raw）
 *   3. 环境变量 DSH_FORGE_* （排障用，例如 DSH_FORGE_L2=1）
 *
 * 只做浅合并 + 白名单，避免深合并带来的"半个对象"问题。
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LAYER_IDS, LAYERS } from './hooks.js'
import { CAPABILITIES, CAPABILITY_IDS } from './capabilities.js'

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULTS = Object.freeze({
  enabled: true,
  verbose: false,
  promptFile: '',
  promptOrder: -1001,
  stripSections: ['harness:identity'],
  modsDir: '',
  // 层默认开关来自 LAYERS.defaultOn —— 加层时不用改这里。
  layers: Object.fromEntries(LAYER_IDS.map((id) => [id, LAYERS[id].defaultOn === true])),
  // 覆盖官方 context 文案，例：{ "approval:policy": "..." }。null = 不改任何现有段。
  contextOverrides: null,
  // L0 能力表：默认值全部来自 CAPABILITIES[id].default（默认全 false）。
  l0: {
    readOnly: true,
    sourcePatch: { enabled: false },
    capabilities: Object.fromEntries(CAPABILITY_IDS.map((id) => [id, CAPABILITIES[id].default === true])),
  },
  update: { repo: '', ref: 'main', sha256: '' },
  middleware: {},
})

function bool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return fallback
}

function strList(value, fallback) {
  if (Array.isArray(value)) return value.map((x) => String(x)).filter(Boolean)
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  }
  return fallback
}

function obj(value, fallback) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
}

/**
 * @param {object} raw 宿主传入的 config
 * @param {Record<string,string|undefined>} env
 */
export function resolveConfig(raw = {}, env = process.env) {
  const src = obj(raw, {})
  const layersIn = obj(src.layers, {})
  const l0In = obj(src.l0, {})
  const capsIn = obj(l0In.capabilities, {})
  const patchIn = obj(l0In.sourcePatch, {})
  const updateIn = obj(src.update, {})

  const cfg = {
    enabled: bool(env.DSH_FORGE_ENABLED, bool(src.enabled, DEFAULTS.enabled)),
    verbose: bool(env.DSH_FORGE_VERBOSE, bool(src.verbose, DEFAULTS.verbose)),
    promptFile: typeof src.promptFile === 'string' ? src.promptFile.trim() : DEFAULTS.promptFile,
    promptOrder: Number.isFinite(Number(src.promptOrder)) ? Number(src.promptOrder) : DEFAULTS.promptOrder,
    stripSections: strList(src.stripSections, DEFAULTS.stripSections),
    modsDir: typeof src.modsDir === 'string' ? src.modsDir.trim() : DEFAULTS.modsDir,
    contextOverrides: obj(src.contextOverrides, DEFAULTS.contextOverrides),
    layers: {},
    l0: {
      readOnly: bool(l0In.readOnly, DEFAULTS.l0.readOnly),
      sourcePatch: { enabled: bool(patchIn.enabled, DEFAULTS.l0.sourcePatch.enabled) },
      capabilities: Object.fromEntries(
        CAPABILITY_IDS.map((id) => {
          const envKey = `DSH_FORGE_CAP_${id.replace(/-/g, '_').toUpperCase()}`
          return [id, bool(env[envKey], bool(capsIn[id], DEFAULTS.l0.capabilities[id]))]
        }),
      ),
    },
    update: {
      repo: typeof updateIn.repo === 'string' ? updateIn.repo.trim() : DEFAULTS.update.repo,
      ref: typeof updateIn.ref === 'string' && updateIn.ref.trim() ? updateIn.ref.trim() : DEFAULTS.update.ref,
      sha256: typeof updateIn.sha256 === 'string' ? updateIn.sha256.trim().toLowerCase() : DEFAULTS.update.sha256,
    },
    middleware: obj(src.middleware, {}),
    dshHome: String(env.DSH_HOME || path.join(os.homedir(), '.dsh')),
  }

  for (const id of LAYER_IDS) {
    const envKey = `DSH_FORGE_${id.toUpperCase()}`
    cfg.layers[id] = bool(env[envKey], bool(layersIn[id], DEFAULTS.layers[id]))
  }

  return cfg
}

/** 该层是否启用。未在配置里出现的层按 LAYERS.defaultOn 兜底。 */
export function layerOpen(cfg, layer) {
  if (cfg.enabled === false) return false
  const value = cfg.layers?.[layer]
  if (typeof value === 'boolean') return value
  return LAYERS[layer]?.defaultOn === true
}

/** 当前被关闭的层集合（供 pipeline 跳过）。 */
export function closedLayers(cfg) {
  const closed = new Set()
  for (const id of LAYER_IDS) if (!layerOpen(cfg, id)) closed.add(id)
  return closed
}

/** 解析提示词文件路径；空 = 插件自带 prompts/base.md。 */
export function promptPath(cfg) {
  const raw = String(cfg.promptFile || '').trim()
  if (!raw) return path.join(PLUGIN_ROOT, 'prompts', 'base.md')
  return path.isAbsolute(raw) ? raw : path.resolve(PLUGIN_ROOT, raw)
}

/** 解析中间件目录；空 = 插件自带 mods/。 */
export function modsPath(cfg) {
  const raw = String(cfg.modsDir || '').trim()
  if (!raw) return path.join(PLUGIN_ROOT, 'mods')
  return path.isAbsolute(raw) ? raw : path.resolve(PLUGIN_ROOT, raw)
}
