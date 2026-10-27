#!/usr/bin/env node
/**
 * 预览：把 dsh-forge 的改写结果**真实渲染出来**给你看。
 *
 * 它不模拟渲染器 —— 直接 import 宿主自己的 `renderPrompt` / `renderContextSections`，
 * 所以看到的拼接结果和宿主发给模型的一模一样。
 *
 *   node scripts/preview.mjs                          # 默认 standard 预设
 *   node scripts/preview.mjs --preset minimal         # 模拟 complete:true
 *   node scripts/preview.mjs --cwd D:\ds\plugins\dsh-forge
 *   node scripts/preview.mjs --layer L3=on --layer L2=on
 *   node scripts/preview.mjs --quiet                  # 只出最终结果
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveAiBase } from '../core/patch.js'
import { resolveConfig } from '../core/config.js'
import { apply } from '../index.js'

/* ------------------------------------------------------------------ 参数 */

const args = process.argv.slice(2)
const quiet = args.includes('--quiet')
function flag(name, fallback = '') {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}
function multi(name) {
  const out = []
  for (let i = 0; i < args.length; i += 1) if (args[i] === name && args[i + 1]) out.push(args[i + 1])
  return out
}

const preset = flag('--preset', 'standard')
const cwd = path.resolve(flag('--cwd', process.cwd()))

/* ------------------------------------------------------------------ 宿主渲染器 */

const aiBase = resolveAiBase()
if (!aiBase) {
  console.error('[preview] 找不到宿主 @deepseek-ai 目录（可用 DSH_FORGE_AIBASE 指定）')
  process.exit(1)
}
const hostMod = await import(
  pathToFileURL(path.join(aiBase, 'dsh-system-prompt', 'lib', 'index.js')).href
)
const { renderPrompt, renderContextSections, joinContextSections } = hostMod

/* ------------------------------------------------------------------ 假 ctx（只捕获注册） */

function makeCtx() {
  const hooks = new Map()
  return {
    hooks,
    on(name, fn) {
      if (!hooks.has(name)) hooks.set(name, [])
      hooks.get(name).push(fn)
      return () => {}
    },
    inject() {},
    effect() {},
    provide() {},
    get() {
      return undefined
    },
  }
}

function lastHandler(ctx, name) {
  const list = ctx.hooks.get(name) || []
  return list.length ? list[list.length - 1] : null
}

/* ------------------------------------------------------------------ 造一份贴近真实的 assembly */

/** 官方 SECTION_ORDERS 里的真实顺序（摘自 dsh-system-prompt/lib/index.js）。 */
function makeAssembly() {
  return {
    sections: [
      {
        name: 'harness:identity',
        order: -1000,
        text: 'You are an AI agent powered by DeepSeek Harness.',
      },
      { name: 'deployment:persona-prefix', order: 0, text: '' },
      {
        name: 'agent-instructions',
        order: 900,
        text: 'The following workspace instructions may be relevant to your work. Use them as guidance when applicable.',
      },
      {
        name: 'tool:bash',
        order: 1000,
        text: '## bash\nRun a shell command.\n* You do not have access to the internet via this tool.',
      },
      { name: 'tool:read', order: 1100, text: '## read\nRead a file from the workspace.' },
      { name: 'tool:edit', order: 1300, text: '## edit\nReplace text in a file.' },
      { name: 'deployment:persona-suffix', order: 10200, text: `Your working directory is ${cwd}.` },
    ],
    contexts: [
      { name: 'sandbox:policy', order: 110, text: 'Sandbox mode: workspace-write. Writes are confined to the workspace root.' },
      {
        name: 'approval:policy',
        order: 115,
        text: 'Approval policy: ask. Operations that require approval may ask through the configured answerers.',
      },
    ],
    tools: [],
    variables: {},
  }
}

/* ------------------------------------------------------------------ 跑 */

const configOverrides = { promptSource: flag('--prompt-source', 'chain') }
for (const item of multi('--layer')) {
  const [id, value] = item.split('=')
  if (!id) continue
  configOverrides.layers = { ...(configOverrides.layers || {}), [id]: value !== 'off' }
}
const promptFile = flag('--prompt-file')
if (promptFile) configOverrides.promptFile = promptFile

const ctx = makeCtx()
apply(ctx, configOverrides)
const forge = ctx.get && null

const assembleHandler = lastHandler(ctx, 'system-prompt/assemble')
if (!assembleHandler) {
  console.error('[preview] assemble 钩子没注册（L1/L1b 都关了？）')
  process.exit(1)
}

const before = makeAssembly()
const after = await assembleHandler(before, { agent: { session: { header: { cwd } } } }, async () => before)

/* complete:true 预设：宿主会把 sections 换成唯一那段 */
let effective = after
let completeNote = ''
if (preset === 'minimal') {
  const completeSection = { name: 'deployment:persona-prefix', text: 'You are a coding agent. Work in the repository.' }
  effective = {
    ...after,
    sections: [completeSection],
    contexts: after.contexts,
  }
  completeNote = '宿主 complete:true → sections 被换成唯一一段（L1 失效，L1b 保留）'
}

/* ------------------------------------------------------------------ 渲染 */

const renderedBefore = renderPrompt(before)
const renderedAfter = renderPrompt(effective)
const ctxAfter = joinContextSections(renderContextSections(effective))

function line(text = '') {
  console.log(text)
}
function head(title) {
  line()
  line('═'.repeat(72))
  line(title)
  line('═'.repeat(72))
}
function bytesOf(text) {
  return `${Buffer.byteLength(text || '', 'utf8')}B`
}
function table(rows) {
  const w = Math.max(...rows.map((r) => String(r[0]).length), 4)
  for (const r of rows) line(`  ${String(r[0]).padEnd(w)}  ${r[1]}`)
}

if (!quiet) {
  head('1. 组装输入（模拟宿主 sections / contexts）')
  table(before.sections.map((s) => [s.name, `${bytesOf(s.text).padStart(7)}  order=${s.order}`]))
  line('  contexts:')
  table(before.contexts.map((c) => [`  ${c.name}`, `${bytesOf(c.text).padStart(7)}  order=${c.order}`]))

  head('2. 经 dsh-forge 改写后')
  table(after.sections.map((s) => [s.name, `${bytesOf(s.text).padStart(7)}  order=${s.order}`]))
  line('  contexts:')
  table(after.contexts.map((c) => [`  ${c.name}`, `${bytesOf(c.text).padStart(7)}  order=${c.order}`]))

  const added = after.sections.filter((s) => !before.sections.some((b) => b.name === s.name)).map((s) => s.name)
  const removed = before.sections.filter((b) => !after.sections.some((s) => s.name === b.name)).map((b) => b.name)
  const ctxAdded = after.contexts.filter((c) => !before.contexts.some((b) => b.name === c.name)).map((c) => c.name)
  line()
  line(`  新增段: ${added.join(', ') || '（无）'}`)
  line(`  移除段: ${removed.join(', ') || '（无）'}`)
  line(`  新增 ctx: ${ctxAdded.join(', ') || '（无）'}`)
  line(`  系统提示词: ${bytesOf(renderedBefore)} → ${bytesOf(renderedAfter)}`)
}

if (preset === 'minimal') {
  head('3. complete:true 预设的影响')
  line(`  ${completeNote}`)
  line(`  最终 sections: ${effective.sections.map((s) => s.name).join(', ')}`)
  line(`  最终 contexts: ${effective.contexts.map((c) => c.name).join(', ')}`)
  const l1Kept = effective.sections.some((s) => s.name === 'forge:prompt')
  const l1bKept = effective.contexts.some((c) => c.name === 'forge:context')
  line()
  line(`  L1 提示词保留: ${l1Kept ? '是' : '否 ← 这就是为什么要用 L1b'}`)
  line(`  L1b 硬规则保留: ${l1bKept ? '是' : '否'}`)
}

head(`最终 system prompt（${bytesOf(renderedAfter)}）`)
line(renderedAfter)

if (ctxAfter) {
  head(`附加到每一步的 runtime context（${bytesOf(ctxAfter)}）`)
  line(ctxAfter)
}

head('提示词来源')
const promptSrc = args.includes('--quiet') ? '' : ''
const rulesDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'forge', 'rules')
line(`  cwd        ${cwd}`)
line(`  rules 目录 ${rulesDir}${fs.existsSync(rulesDir) ? '' : '（不存在）'}`)
line(`  层开关     ${JSON.stringify(configOverrides.layers || 'default')}`)
line(`  预设       ${preset}`)
