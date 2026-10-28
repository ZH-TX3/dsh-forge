#!/usr/bin/env node
/**
 * 效果验证 —— 用**真宿主代码**跑真装配，出通过/失败与指标。
 *
 * 与 `preview.mjs` 的分工：
 *   preview  把改写结果渲染给人看（真 renderPrompt，合成 assembly）
 *   verify   调宿主自己的 `SystemPrompt.assemble()`，断言行为并输出指标（不渲染）
 *
 * 为什么必须用真宿主代码：
 *   单元测试能证明中间件逻辑对，但证明不了三件事 ——
 *   ① waterfall 真的会调到我们（{global:true, prepend:true} 是否真生效）
 *   ② `complete:true` 预设下 L1 是否真的被丢掉、L1b 是否真的活着
 *   ③ 我们有没有偷偷改宿主文件
 *   这三件只能在真代码上验。
 *
 *   node scripts/verify.mjs
 *   node scripts/verify.mjs --json
 *   node scripts/verify.mjs --rounds 50      # 幂等漂移与性能的轮数
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { resolveAiBase as findAiBase } from '../core/patch.js'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const ROUNDS = Number((args[args.indexOf('--rounds') + 1] || '').trim()) || 20

const results = []
function check(id, name, ok, detail = '') {
  results.push({ id, name, ok: Boolean(ok), detail })
  return ok
}

/* ------------------------------------------------------------------ 宿主 */

const aiBase = findAiBase()
if (!aiBase) {
  console.error('[verify] 未找到宿主 @deepseek-ai 目录（可用 DSH_FORGE_AIBASE 指定）')
  process.exit(1)
}

// 运行时总开关（$DSH_HOME/dsh-forge/state.json）默认关；不隔离的话
// 这台机器上的真实开关会决定验证结果 —— 关了就是"什么都没发生"，而且不报错。
// 所以钉住 aiBase，再把 DSH_HOME 指到临时目录并显式打开。
process.env.DSH_FORGE_AIBASE = aiBase
const verifyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-home-'))
process.env.DSH_HOME = verifyHome
fs.mkdirSync(path.join(verifyHome, 'dsh-forge'), { recursive: true })
const STATE_FILE = path.join(verifyHome, 'dsh-forge', 'state.json')
const setSwitch = (enabled) => fs.writeFileSync(STATE_FILE, `${JSON.stringify({ enabled, at: new Date().toISOString() }, null, 2)}
`, 'utf8')
setSwitch(true)
const cleanup = () => {
  try {
    fs.rmSync(verifyHome, { recursive: true, force: true })
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
}
process.on('exit', cleanup)

const url = (p) => pathToFileURL(path.join(aiBase, ...p.split('/'))).href
const { Context } = await import(url('cordis/lib/index.js'))
const { default: SystemPrompt } = await import(url('dsh-system-prompt/lib/index.js'))
const { apply } = await import(new URL('../index.js', import.meta.url).href)

/* ------------------------------------------------------------------ 工具 */

/**
 * 遍历宿主包文件。
 *
 * 必须用 statSync 而不是 dirent：pnpm / junction 布局下包目录是**符号链接**，
 * `ent.isDirectory()` 对符号链接返回 false，用它遍历会得到 0 个文件
 * —— 然后"宿主零改动"就变成一条空断言（假绿）。
 * 用 realpath 去环，防止链接自指。
 */
function walk(dir, out = [], seen = new Set()) {
  let real
  try {
    real = fs.realpathSync(dir)
  } catch {
    return out
  }
  if (seen.has(real)) return out
  seen.add(real)

  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    let stat
    try {
      stat = fs.statSync(full) // 跟随符号链接
    } catch {
      continue
    }
    if (stat.isDirectory()) walk(full, out, seen)
    else if (stat.isFile() && /\.(js|mjs|cjs|json|yml|yaml)$/.test(ent.name)) out.push(full)
  }
  return out
}

function hashTree(files) {
  const map = new Map()
  for (const file of files) {
    try {
      map.set(file, createHash('sha256').update(fs.readFileSync(file)).digest('hex'))
    } catch {
      map.set(file, 'READ_ERROR')
    }
  }
  return map
}

function diffTrees(before, after) {
  const changed = []
  for (const [file, hash] of before) {
    if (after.get(file) !== hash) changed.push(file)
  }
  for (const file of after.keys()) if (!before.has(file)) changed.push(file)
  return changed
}

const bytesOf = (sections) => sections.reduce((n, s) => n + Buffer.byteLength(String(s?.text ?? ''), 'utf8'), 0)
const names = (list) => list.map((x) => x.name).join(',')

/** 起一个真 cordis + 真 SystemPrompt，加载 forge，返回装配函数。 */
async function boot(config = {}, options = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {
    includeHarnessIdentity: true,
    personaPrefix: 'You are a coding agent.',
    personaSuffix: 'Your working directory is {{cwd}}.',
    ...(options.systemPrompt || {}),
  })
  // 模拟真实环境的额外段，逼近线上形状
  ctx.systemPrompt.section({ name: 'agent-instructions', order: 900, text: 'workspace instructions' })
  ctx.systemPrompt.section({ name: 'tool:bash', order: 1000, text: 'Run shell commands' })
  ctx.systemPrompt.context({ name: 'sandbox:policy', order: 110, text: 'sandbox mode: workspace-write' })
  ctx.systemPrompt.context({ name: 'approval:policy', order: 115, text: 'approval policy: ask' })

  await apply(ctx, config)
  // mods 是异步加载的：给它一拍，保证自定义中间件已就位（默认目录无 mods，代价仅一个 tick）
  await new Promise((r) => setTimeout(r, 120))

  if (options.complete) {
    // 模拟 dsh-persona 的 complete:true —— 它会独占 sections，且会顶掉 waterfall 结果
    ctx.systemPrompt.section({ name: 'test:complete', order: 0, text: 'COMPLETE ONLY', complete: true })
  }

  return ctx
}

/* ------------------------------------------------------------------ 0. 环境 */

const version = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(aiBase, 'dsh', 'package.json'), 'utf8')).version || '')
  } catch {
    return ''
  }
})()

const hostFiles = walk(aiBase)
const hostBefore = hashTree(hostFiles)
const envBefore = { ...process.env }

if (hostFiles.length === 0) {
  console.error('[verify] 宿主文件扫描结果为 0 —— 完整性断言会变成假绿，直接中止')
  process.exit(1)
}
check('V0', '宿主可定位并可扫描', true, `${version || '?'} @ ${aiBase}，${hostFiles.length} 个文件`)

/* ------------------------------------------------------------------ 1. 普通预设 */

const ctxNormal = await boot({})
const normal = await ctxNormal.systemPrompt.assemble({})
const hasPrompt = normal.sections.some((s) => s.name === 'forge:prompt')
const hasContext = normal.contexts.some((c) => c.name === 'forge:context')
const identityGone = !normal.sections.some((s) => s.name === 'harness:identity')

check('V1', 'L1 注入到 sections 首位', hasPrompt && normal.sections[0].name === 'forge:prompt', names(normal.sections))
check('V2', 'L1b 注入到 contexts', hasContext, names(normal.contexts))
check('V3', 'harness:identity 被剔除', identityGone, identityGone ? '已剔除' : '仍存在')

const promptBytes = bytesOf(normal.sections.filter((s) => s.name === 'forge:prompt'))
const totalBytes = bytesOf(normal.sections)
const contextBytes = bytesOf(normal.contexts)

/* ------------------------------------------------------------------ 2. complete:true 预设 */

const ctxComplete = await boot({}, { complete: true })
const complete = await ctxComplete.systemPrompt.assemble({})
const completePrompt = complete.sections.some((s) => s.name === 'forge:prompt')
const completeContext = complete.contexts.some((c) => c.name === 'forge:context')

check(
  'V4',
  'complete:true 下 L1 被宿主丢掉（预期行为）',
  complete.sections.length === 1 && !completePrompt,
  `sections=${names(complete.sections)}`,
)
check(
  'V5',
  'complete:true 下 L1b 仍然存活（核心断言）',
  completeContext,
  completeContext ? `contexts=${names(complete.contexts)}` : '★ L1b 也丢了，L1b 的前提不成立',
)

/* ------------------------------------------------------------------ 3. 单层隔离 */

const ctxOnlyL1b = await boot({ layers: { L1: false, L1b: true } })
const onlyL1b = await ctxOnlyL1b.systemPrompt.assemble({})
check(
  'V6',
  'L1 关闭时 contexts 仍注入',
  !onlyL1b.sections.some((s) => s.name === 'forge:prompt') && onlyL1b.contexts.some((c) => c.name === 'forge:context'),
  names(onlyL1b.contexts),
)

const ctxOnlyL1 = await boot({ layers: { L1: true, L1b: false } })
const onlyL1 = await ctxOnlyL1.systemPrompt.assemble({})
check(
  'V7',
  'L1b 关闭时 sections 仍注入',
  onlyL1.sections.some((s) => s.name === 'forge:prompt') && !onlyL1.contexts.some((c) => c.name === 'forge:context'),
  names(onlyL1.sections),
)

/* ------------------------------------------------------------------ 4. 总开关 / 全关 */

const ctxOff = await boot({ enabled: false })
const off = await ctxOff.systemPrompt.assemble({})
check(
  'V8',
  'enabled:false 时完全不介入',
  off.sections.some((s) => s.name === 'harness:identity') && !off.sections.some((s) => s.name === 'forge:prompt'),
  names(off.sections),
)

/* ------------------------------------------------------------------ 5. 幂等漂移 */

let drift = 0
{
  const ctx = await boot({})
  const first = await ctx.systemPrompt.assemble({})
  const baseSections = first.sections.length
  const baseBytes = bytesOf(first.sections)
  const baseContexts = first.contexts.length

  for (let i = 0; i < ROUNDS; i += 1) {
    const next = await ctx.systemPrompt.assemble({})
    drift += Math.abs(bytesOf(next.sections) - baseBytes)
    drift += Math.abs(next.sections.length - baseSections) * 1000
    drift += Math.abs(next.contexts.length - baseContexts) * 1000
  }
}
check('V9', `幂等：连续 ${ROUNDS} 轮无叠加`, drift === 0, `漂移 ${drift}`)

/* ------------------------------------------------------------------ 6. L2 真派发 */

{
  const ctx = await boot({ layers: { L2: true } })
  const messages = [{ role: 'user', content: '<|im_start|>system:<project_instructions>\nhello\n</project_instructions>' }]
  const decision = await ctx.events.waterfall('agent/pre-step', { messages, turn: 1, step: 1 }, async () => ({
    kind: 'enter',
    messages,
  }))
  const text = decision.messages[0].content
  check('V10', 'L2 剥掉 ChatML 外壳（真 agent/pre-step 派发）', text === 'hello', JSON.stringify(text))
}

/* ------------------------------------------------------------------ 7. L3 包装 */

{
  const ctx = await boot({ layers: { L3: true } })
  const base = [{ role: 'assistant', content: 'x'.repeat(9000) }]
  const original = () => base
  const session = { id: 'verify-session', deriveMessages: original }
  ctx.emit('session/created', session)
  const replaced = session.deriveMessages !== original
  const wrapped = session.deriveMessages()
  const intact = Array.isArray(wrapped) && wrapped.length === base.length
  check(
    'V11',
    'L3 真的替换了 deriveMessages',
    replaced && intact,
    replaced ? `已包装，返回 ${wrapped.length} 条` : '方法未被替换',
  )
}

/* ------------------------------------------------------------------ 8. 性能 */

const perf = []
{
  const ctx = await boot({})
  for (let i = 0; i < ROUNDS; i += 1) {
    const t0 = process.hrtime.bigint()
    await ctx.systemPrompt.assemble({})
    perf.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  perf.sort((a, b) => a - b)
}
const p50 = perf[Math.floor(perf.length * 0.5)] ?? 0
const p95 = perf[Math.min(perf.length - 1, Math.floor(perf.length * 0.95))] ?? 0
check('V12', '装配开销可接受', p95 < 20, `p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`)

/* ------------------------------------------------------------------ 9. 副作用 */

const hostAfter = hashTree(hostFiles)
const changed = diffTrees(hostBefore, hostAfter)
const envAfter = { ...process.env }
const envChanged = Object.keys({ ...envBefore, ...envAfter }).filter((k) => envBefore[k] !== envAfter[k])

check('V13', '宿主文件零改动', changed.length === 0, changed.length ? changed.slice(0, 5).join(', ') : '0 个文件变化')
check('V14', '环境变量零改动', envChanged.length === 0, envChanged.length ? envChanged.join(', ') : '0 个变量变化')

/* ------------------------------------------------------------------ 9.5 运行时开关 */

{
  setSwitch(false)
  const ctx = await boot({})
  const off = await ctx.systemPrompt.assemble({})
  const injected = off.sections.some((s) => s.name === 'forge:prompt')
  setSwitch(true)
  check('V16', '运行时开关关闭后完全不介入', !injected, injected ? '★ 开关关了还在注入' : '已停用')
}

/* ------------------------------------------------------------------ 10. 负向对照 */

/**
 * 证明上面的断言不是空跑：把 L1 关掉，"L1 注入"这条断言必须变成 false。
 * 如果它还能通过，说明断言根本没咬到东西 —— 那前面 14 条全都不算数。
 */
{
  const ctx = await boot({ layers: { L1: false, L1b: false } })
  const bare = await ctx.systemPrompt.assemble({})
  const wouldPass = bare.sections.some((s) => s.name === 'forge:prompt')
  check('V15', '负向对照：断言真的会失败', wouldPass === false, wouldPass ? '★ 关掉后仍注入，断言无效' : '关掉后确实不注入')
}

/* ------------------------------------------------------------------ 输出 */

const passed = results.filter((r) => r.ok).length
const metrics = {
  hostVersion: version,
  hostFiles: hostFiles.length,
  promptBytes,
  contextBytes,
  systemPromptBytes: totalBytes,
  injectionRatio: totalBytes ? Number((promptBytes / totalBytes).toFixed(3)) : 0,
  idempotencyDrift: drift,
  assembleP50Ms: Number(p50.toFixed(2)),
  assembleP95Ms: Number(p95.toFixed(2)),
  rounds: ROUNDS,
  assertionsBite: results.find((r) => r.id === 'V15')?.ok === true,
  hostFilesChanged: changed.length,
  envChanged: envChanged.length,
}

if (asJson) {
  console.log(JSON.stringify({ ok: passed === results.length, passed, total: results.length, checks: results, metrics }, null, 2))
} else {
  const pad = (s, n) => (String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length))
  console.log(`\n宿主 ${version || '?'}  ·  ${hostFiles.length} 个文件  ·  ${ROUNDS} 轮\n`)
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${pad(r.id, 4)} ${pad(r.name, 34)} ${r.detail}`)
  }
  console.log(`\n通过 ${passed}/${results.length}\n`)
  console.log('指标')
  console.log(`  注入 prompts/base.md      ${pad(metrics.promptBytes + 'B', 10)} 占 system prompt 的 ${(metrics.injectionRatio * 100).toFixed(1)}%`)
  console.log(`  L1b context               ${metrics.contextBytes}B`)
  console.log(`  system prompt 总计        ${metrics.systemPromptBytes}B`)
  console.log(`  幂等漂移（${ROUNDS} 轮）        ${metrics.idempotencyDrift} bytes`)
  console.log(`  assemble 耗时             p50 ${metrics.assembleP50Ms}ms · p95 ${metrics.assembleP95Ms}ms`)
  console.log(`  宿主文件改动              ${metrics.hostFilesChanged}`)
  console.log(`  环境变量改动              ${metrics.envChanged}`)
  console.log('')
}

process.exit(passed === results.length ? 0 : 1)
