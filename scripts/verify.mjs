#!/usr/bin/env node
/**
 * forge 模式验证 —— 用**真宿主代码**跑真装配。
 *
 * 与 v1 的区别：v1 验的是「一个全局插件改得对不对」；
 * 这里验的是「模式边界在不在」—— 同一个宿主、两个 scope，
 * 一个选锻造模式、一个不选，装配结果必须不同，且不选的那边逐字节干净。
 *
 *   node scripts/verify.mjs
 *   node scripts/verify.mjs --json
 *
 * 环境：DSH_FORGE_AIBASE 指向宿主 @deepseek-ai 目录（一般自动找到）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')

const results = []
function check(id, name, ok, detail = '') {
  results.push({ id, name, ok: Boolean(ok), detail })
  return ok
}

/* ------------------------------------------------------------------ 宿主 */

function findAiBase() {
  // 宿主有两种布局：
  //   <root>/node_modules/@deepseek-ai                        （依赖平铺）
  //   <root>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai （dsh 自带嵌套）
  const isAiBase = (dir) => Boolean(dir) && fs.existsSync(path.join(dir, 'dsh-system-prompt', 'lib', 'index.js'))
  const roots = [
    process.env.DSH_FORGE_AIBASE,
    process.env.DSH_PACKAGE_DIR,
    path.dirname(process.execPath),
    'D:/nvm/v24.18.1',
    path.join(process.env.APPDATA || '', 'npm'),
  ].filter(Boolean)

  for (const root of roots) {
    const base = path.resolve(root)
    if (isAiBase(base)) return base
    for (const rel of ['node_modules/@deepseek-ai', 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai']) {
      const dir = path.join(base, ...rel.split('/'))
      if (isAiBase(dir)) return dir
    }
  }
  return null
}

const aiBase = findAiBase()
if (!aiBase) {
  console.error('[verify] 未找到宿主 @deepseek-ai 目录（用 DSH_FORGE_AIBASE 指定）')
  process.exit(1)
}

const url = (p) => pathToFileURL(path.join(aiBase, ...p.split('/'))).href
const { Context } = await import(url('cordis/lib/index.js'))
const { default: SystemPrompt } = await import(url('dsh-system-prompt/lib/index.js'))
const { createScope, scopeOf } = await import(url('dsh-scope/lib/index.js'))
const personaFeature = await import(new URL('../features/persona/index.js', import.meta.url).href)
const rulesFeature = await import(new URL('../features/rules/index.js', import.meta.url).href)

const BASE_MD = fs.readFileSync(path.join(ROOT, 'data/prompts/base.md'), 'utf8')
const RULE_FILES = fs
  .readdirSync(path.join(ROOT, 'data/rules'))
  .filter((f) => f.toLowerCase().endsWith('.md'))
  .sort()
const RULE_FIRST = fs.readFileSync(path.join(ROOT, 'data/rules', RULE_FILES[0]), 'utf8')
const BASE_MARK = '操作者提示词'
const RULE_MARK = '执行约定'

/* ------------------------------------------------------------------ 布景 */

/** 一个真宿主：只装 prompt 注册表，没装任何 forge 代码。 */
async function newHost() {
  const host = new Context()
  await host.plugin(SystemPrompt, {})
  return host
}

/** 在 host 上开一个 scope 并挂 forge 的两个 feature。 */
async function mountForge(host, extraPlugins = []) {
  const key = {}
  const scope = createScope(host, key)
  await scope.ctx.plugin(personaFeature, { file: 'data/prompts/base.md', complete: true, order: 100 })
  await scope.ctx.plugin(rulesFeature, { dir: 'data/rules', order: 100 })
  for (const { plugin, config } of extraPlugins) {
    try {
      await scope.ctx.plugin(plugin, config ?? {})
    } catch {
      // 这里就是要让它抛：失败隔离由断言兜
    }
  }
  return { key, scope }
}

const host = await newHost()
const sp = host.systemPrompt
const forge = await mountForge(host)

const otherKey = {}
const otherScope = createScope(host, otherKey)

const forgeAsm = await sp.assemble({ scope: forge.key })
const otherAsm = await sp.assemble({ scope: otherKey })
const globalAsm = await sp.assemble({})

const names = (list) => list.map((x) => x.name)
const find = (list, name) => list.find((x) => x.name === name)

/* ------------------------------------------------------------- V-A 正例 */

check(
  'V-A1',
  '锻造模式装配含 L1 长人设，且 complete 收尾后只剩这一段',
  names(forgeAsm.sections).length === 1 &&
    forgeAsm.sections[0].name === 'forge:persona' &&
    String(forgeAsm.sections[0].text).includes(BASE_MARK),
  `sections=${JSON.stringify(names(forgeAsm.sections))}`,
)

check(
  'V-A2',
  `锻造模式装配含全部 L1b 硬规则（${RULE_FILES.length} 条）`,
  RULE_FILES.every((file) => {
    const entry = find(forgeAsm.contexts, `forge:rule:${file.replace(/\.md$/i, '')}`)
    return Boolean(entry) && String(entry.text).includes(RULE_MARK)
  }),
  `contexts=${JSON.stringify(names(forgeAsm.contexts))}`,
)

/* -------------------------------------------------- V-B 负向对照（咬得住） */

check(
  'V-B1',
  '不选模式的 scope 里没有 forge 的 section（作用域即闸门）',
  find(otherAsm.sections, 'forge:persona') === undefined,
  `sections=${JSON.stringify(names(otherAsm.sections))}`,
)

check(
  'V-B2',
  '不选模式的 scope 里没有 forge 的 context',
  names(otherAsm.contexts).every((n) => !n.startsWith('forge:')),
  `contexts=${JSON.stringify(names(otherAsm.contexts))}`,
)

check(
  'V-B3',
  '对照 scope 里宿主自己的段还在（证明断言不是在空装配上通过的）',
  otherAsm.sections.length > 1 && names(otherAsm.sections).includes('harness:identity'),
  `sections=${names(otherAsm.sections).length} 段`,
)

check(
  'V-B4',
  '全局装配同样不受 forge 影响',
  find(globalAsm.sections, 'forge:persona') === undefined &&
    names(globalAsm.contexts).every((n) => !n.startsWith('forge:')),
  `sections=${JSON.stringify(names(globalAsm.sections))}`,
)

/* ------------------------------------------- V-F complete 与 contexts 并存 */

check(
  'V-F',
  'complete 收尾吃掉 sections 后，硬规则仍在 contexts 里',
  forgeAsm.sections.length === 1 && forgeAsm.contexts.length > 0,
  `sections=${forgeAsm.sections.length} contexts=${forgeAsm.contexts.length}`,
)

/* ------------------------------------------------------- V-E 失败隔离 */

const brokenFeature = {
  name: 'forge-broken-probe',
  inject: ['systemPrompt'],
  apply() {
    throw new Error('probe: 故意在 apply 里抛错')
  },
}
const isolated = await mountForge(host, [{ plugin: brokenFeature }])
const isolatedAsm = await sp.assemble({ scope: isolated.key })
check(
  'V-E',
  '同 scope 内一个 feature 抛错，persona 与 rules 照常挂上',
  find(isolatedAsm.sections, 'forge:persona') !== undefined && isolatedAsm.contexts.length > 0,
  `sections=${JSON.stringify(names(isolatedAsm.sections))} contexts=${isolatedAsm.contexts.length}`,
)

/* --------------------------------------------------- V-D 数据层热更新 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-'))
const tmpFile = path.join(tmpDir, 'hot.md')
const hotHost = await newHost()
const hotKey = {}
const hotScope = createScope(hotHost, hotKey)
fs.writeFileSync(tmpFile, '第一版正文', 'utf8')
await hotScope.ctx.plugin(personaFeature, { file: tmpFile, order: 100 })
const before = await hotHost.systemPrompt.assemble({ scope: hotKey })
await new Promise((r) => setTimeout(r, 10))
fs.writeFileSync(tmpFile, '第二版正文（更长一点，确保 size 变化）', 'utf8')
const after = await hotHost.systemPrompt.assemble({ scope: hotKey })
check(
  'V-D',
  '数据层改文件即生效（mtime+size 缓存真的会失效）',
  String(find(before.sections, 'forge:persona')?.text).includes('第一版') &&
    String(find(after.sections, 'forge:persona')?.text).includes('第二版'),
  `before=${JSON.stringify(find(before.sections, 'forge:persona')?.text?.slice(0, 6))} after=${JSON.stringify(find(after.sections, 'forge:persona')?.text?.slice(0, 6))}`,
)
fs.rmSync(tmpDir, { recursive: true, force: true })

/* ------------------------------------------------ V-C 宿主组合零侵入 */

const patchText = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
const hostRowPattern = /name:\s*'?@deepseek-ai\/dsh-[a-z-]+'?/g
const hostRows = [...patchText.matchAll(hostRowPattern)].map((m) => m[0])
const onlyPresetRow = hostRows.length === 1 && hostRows[0].includes('dsh-agent-preset')
// 顶层补丁行 = 行首无缩进的 `- xxx:`。允许且只允许一个 `- insert:`；
// 出现 `- id:` 顶层行就意味着在 override 别人的行。
const topLevelRows = [...patchText.matchAll(/^- (id|insert|group|override):/gm)].map((m) => m[0])
const onlyOneInsert = topLevelRows.length === 1 && topLevelRows[0] === '- insert:'
check(
  'V-C1',
  'bundle patch 只声明预设行，不 insert / override 任何宿主插件',
  onlyPresetRow && onlyOneInsert && !/^\s*disabled:/m.test(patchText) && !/^\s*isolate:/m.test(patchText),
  `宿主行=${JSON.stringify(hostRows)} 顶层行=${JSON.stringify(topLevelRows)}`,
)

const profilePatchCandidates = [
  path.join(process.env.DSH_HOME || '', 'profiles', process.env.DSH_PROFILE || '', 'cordis.patch.yml'),
  path.join(process.env.DSH_HOME || '', 'cordis.patch.yml'),
].filter((p) => p && fs.existsSync(p))
const profileTouched = profilePatchCandidates.filter((p) => /dsh-forge|锻造模式/.test(fs.readFileSync(p, 'utf8')))
check(
  'V-C2',
  '用户 profile 补丁里没有 forge 的行（模式不靠改用户配置生效）',
  profileTouched.length === 0,
  profileTouched.length ? `命中 ${profileTouched.join(', ')}` : `${profilePatchCandidates.length} 个 profile 补丁已检查`,
)

/* ------------------------------------------------------------------ 输出 */

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed

if (asJson) {
  console.log(JSON.stringify({ aiBase, passed, failed, results }, null, 2))
} else {
  console.log(`\n宿主：${aiBase}\n`)
  for (const r of results) {
    const flag = r.ok ? 'PASS' : 'FAIL'
    console.log(`${flag}  ${r.id.padEnd(5)} ${r.name}`)
    if (!r.ok && r.detail) console.log(`       ↳ ${r.detail}`)
  }
  console.log(`\n${passed}/${results.length} 通过${failed ? `，${failed} 失败` : ''}\n`)
}

process.exit(failed === 0 ? 0 : 1)
