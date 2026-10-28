/**
 * dsh-forge —— 分层的提示词/上下文锻造插件。
 *
 * 本文件只做装配，而且**不认识任何具体的层名**：
 *
 *     core/hooks.js   LAYERS（改哪份数据）+ HOOKS（宿主在哪一刻给我入口）
 *     core/runner.js  把钩子形态翻译成「跑哪些层的中间件」
 *     layers/         内置中间件（和 mods/ 里的走同一条管线）
 *
 * 想加一层：在 LAYERS 加一行。
 * 想接一个新钩子：在 HOOKS 加一行。
 * 两种情况都不用碰这个文件。
 *
 * 硬约束：不写任何 @deepseek-ai/* 文件，不改 process.env，不改用户开关。
 * 卸载即完全还原 —— 因为没有留下任何需要还原的东西。
 */
import path from 'node:path'
import { PLUGIN_ROOT, closedLayers, layerOpen, modsPath, resolveConfig } from './core/config.js'
import { Journal } from './core/journal.js'
import { Pipeline } from './core/pipeline.js'
import { HOOKS, LAYER_IDS, LAYERS } from './core/hooks.js'
import { createRunner } from './core/runner.js'
import { readIfExists, resolvePrompt, clearCache as clearSourceCache } from './core/source.js'
import { loadMods, modDirStatus } from './core/loader.js'
import { builtinMiddlewares, CONTEXT_SECTION, PROMPT_SECTION } from './layers/builtin.js'
import { describeCapabilities, installCapabilities } from './core/capabilities.js'
import { describeEffects, installEffects } from './core/effects.js'
import { adviceReport } from './core/advice.js'
import { isEnabled as stateEnabled, readState, setUiVisible, writeState } from './core/state.js'
import { activeRule, listRules, setActiveRule } from './core/source.js'
import { PATCHES, isDefined } from './patches/catalog.js'
import * as hostPolicy from './core/host.js'
import { installBackend } from './backend.js'

export const name = 'dsh-forge'

// 只声明一定会存在的服务。webServer 之类一律软取，
// 否则在 headless / tui profile 下插件会永远 pending，宿主起不来。
export const inject = ['systemPrompt']

const CONTEXT_DOC = path.join(PLUGIN_ROOT, 'prompts', 'context.md')

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const journal = new Journal()
  const pipeline = new Pipeline({ journal, overrides: config.middleware })
  const modsDir = modsPath(config)

  // 内置先注册，mods 后注册 → 同 id 时 mods 覆盖内置，这是有意的扩展手段。
  pipeline.registerAll(builtinMiddlewares, 'builtin')

  let modState = { dir: modsDir, exists: false, files: [], errors: [] }

  /** 总开关：配置允许 + 用户运行时开关。每步都会问，读的是 500ms TTL 缓存。 */
  const active = () => stateEnabled(config.dshHome, config)

  async function reloadMods() {
    const { specs, errors } = await loadMods(modsDir)
    for (const spec of specs) {
      try {
        pipeline.register(spec, 'mod')
      } catch (error) {
        errors.push({ file: String(spec?.id ?? '(no id)'), error: String(error?.message || error) })
      }
    }
    modState = { ...modDirStatus(modsDir), errors }
    for (const error of errors) {
      journal.record({ layer: 'mods', id: 'mods', op: 'error', note: `${error.file}: ${error.error}` })
    }
    return modState
  }

  // mods 异步加载，不阻塞 apply：首轮请求到来前通常已加载完，
  // 万一没加载完也只是少了自定义中间件，内置功能不受影响。
  reloadMods().catch((error) => {
    journal.record({ layer: 'mods', id: 'mods', op: 'error', note: String(error?.message || error) })
  })

  /** 传给中间件的上下文。只读、每次现算。 */
  function cwdOf(hostContext, extra) {
    try {
      return String((hostContext?.agent ?? extra?.agent)?.session?.header?.cwd || '').trim()
    } catch {
      return ''
    }
  }

  function forgeContext(hostContext, extra = {}) {
    const cwd = cwdOf(hostContext, extra)
    const prompt = resolvePrompt(config, { cwd })
    const contextDoc = readIfExists(CONTEXT_DOC)
    const agent = hostContext?.agent ?? extra.agent ?? null
    return {
      config,
      journal,
      pipeline,
      promptText: prompt.text,
      promptFrom: prompt.from,
      promptSource: prompt.source,
      promptExists: prompt.exists,
      cwd,
      promptOrder: config.promptOrder,
      stripSections: config.stripSections,
      contextText: contextDoc ?? '',
      contextOverrides: config.contextOverrides,
      hostContext,
      agent,
      session: agent?.session ?? extra.session ?? null,
      ...extra,
    }
  }

  /* ---------------------------------------------------------------- 公开服务 */

  let capabilityResults = []
  let effectResults = []

  const api = {
    name,
    get config() {
      return config
    },
    journal,
    pipeline,
    reloadMods,
    reloadAll() {
      clearSourceCache()
      return reloadMods()
    },
    /** 提示词链：当前用的是哪一份、有哪些可选。 */
    prompts() {
      const prompt = resolvePrompt(config, { cwd: '' })
      return {
        active: activeRule(config.dshHome),
        source: prompt.source,
        from: prompt.from,
        bytes: Buffer.byteLength(prompt.text, 'utf8'),
        rules: listRules(config.dshHome),
      }
    },
    /** 运行时开关。 */
    state() {
      return { ...readState(config.dshHome), configEnabled: config.enabled !== false }
    },
    setEnabled(enabled) {
      const next = writeState(config.dshHome, { enabled: !!enabled })
      journal.record({ layer: 'core', id: 'switch', op: next.enabled ? 'enable' : 'disable' })
      return next
    },
    setUiVisible(visible) {
      const next = setUiVisible(config.dshHome, visible)
      journal.record({ layer: 'core', id: 'switch', op: visible ? 'ui-on' : 'ui-off' })
      return next
    },
    isActive: active,
    useRule(id) {
      const ok = setActiveRule(config.dshHome, id)
      clearSourceCache()
      return { ok, active: activeRule(config.dshHome) }
    },
    /** 层元数据 —— 让 UI 不必硬编码层名。 */
    layerMeta() {
      return LAYER_IDS.map((id) => ({
        id,
        title: LAYERS[id].title,
        hook: LAYERS[id].hook,
        field: LAYERS[id].field,
        sync: LAYERS[id].sync === true,
        defaultOn: LAYERS[id].defaultOn === true,
      }))
    },
    /** 状态快照，供 backend / 命令 / 排障使用。 */
    status(hostCtx = ctx) {
      const prompt = resolvePrompt(config, { cwd: '' })
      const contextDoc = readIfExists(CONTEXT_DOC)
      const closed = closedLayers(config)
      const st = readState(config.dshHome)
      return {
        enabled: config.enabled !== false && st.enabled !== false,
        configEnabled: config.enabled !== false,
        ui: st.ui !== false,
        switchAt: st.at,
        verbose: config.verbose,
        layers: Object.fromEntries(LAYER_IDS.map((id) => [id, layerOpen(config, id)])),
        layerMeta: api.layerMeta(),
        closed: [...closed],
        prompt: {
          from: prompt.from,
          source: prompt.source,
          exists: prompt.exists,
          bytes: Buffer.byteLength(prompt.text, 'utf8'),
          activeRule: activeRule(config.dshHome),
          rules: listRules(config.dshHome),
        },
        context: { from: CONTEXT_DOC, bytes: Buffer.byteLength(contextDoc ?? '', 'utf8') },
        sections: { prompt: PROMPT_SECTION, context: CONTEXT_SECTION, order: config.promptOrder },
        counts: pipeline.countByLayer(),
        middleware: pipeline.list(),
        mods: modState,
        host: hostPolicy.snapshot(hostCtx ?? ctx),
        capabilities: capabilityResults,
        capabilityMeta: describeCapabilities(config),
        effects: effectResults,
        effectMeta: describeEffects(config),
        advice: adviceReport(hostCtx ?? ctx),
        update: {
          repo: config.update.repo,
          ref: config.update.ref,
          pinned: Boolean(config.update.sha256),
          sha256: config.update.sha256 ? `${config.update.sha256.slice(0, 12)}…` : '',
        },
        stats: { ...journal.stats },
      }
    },
  }

  try {
    ctx.provide('forge', api)
  } catch (error) {
    journal.record({ layer: 'core', id: 'provide', op: 'error', note: String(error?.message || error) })
  }

  /* ---------------------------------------------------------------- L0 基座 */

  // 运行时只允许 native / env 两类能力自动生效。
  // filesystem 与 source-patch 必须走 CLI 显式执行 —— 不在启动时静默动手。
  const caps = installCapabilities({
    ctx,
    config,
    journal,
    patches: PATCHES.filter(isDefined),
    applySourcePatches: false,
  })
  capabilityResults = caps.results

  const effs = installEffects({ ctx, config, journal, isActive: active })
  effectResults = effs.results

  /* ---------------------------------------------------------------- 接线：遍历声明表 */

  const runner = createRunner({
    pipeline,
    journal,
    forgeContext,
    closedLayers: () => closedLayers(config),
    layerEnabled: (id) => layerOpen(config, id),
    isActive: active,
  })

  if (config.enabled) {
    for (const [hookId, hook] of Object.entries(HOOKS)) {
      if (!runner.isLive(hookId)) continue
      try {
        hook.install({ ctx, ...runner })
      } catch (error) {
        journal.record({ layer: 'core', id: `hook:${hookId}`, op: 'error', note: String(error?.message || error) })
      }
    }
  }

  installBackend(ctx, api)

  if (config.verbose) {
    const state = LAYER_IDS.map((id) => `${id}:${layerOpen(config, id) ? 'on' : 'off'}`).join(' ')
    const capsText = capabilityResults.filter((c) => c.enabled).map((c) => `${c.id}:${c.status}`).join(',') || 'none'
    console.log(`[dsh-forge] ${state} on=${active()} mods=${modState.files.length} caps=${capsText}`)
  }
}

export default { name, inject, apply }
