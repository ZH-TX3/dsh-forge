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

/* ------------------------------------------- V-C3 子行 spec 指向真文件 */

// 预设子行不走 Loader 的相对解析，只能用 file:// 绝对路径。
// 代价是路径写死在 patch 里：换目录、搬仓库会静默变成 "never started"。
// 这条断言把它变成开机就报的硬错。
const fileSpecs = [...patchText.matchAll(/name:\s*'(file:\/\/\/[^']+)'/g)].map((m) => m[1])
const relSpecs = [...patchText.matchAll(/name:\s*'\.\/[^']*'/g)].map((m) => m[0])
const specPaths = fileSpecs.map((spec) => fileURLToPath(spec))
const rootLower = ROOT.toLowerCase()
const inRoot = (p) => p.toLowerCase() === rootLower || p.toLowerCase().startsWith(rootLower + path.sep)
const missing = specPaths.filter((p) => !fs.existsSync(p))
const outside = specPaths.filter((p) => !inRoot(p))
check(
  'V-C3',
  '子行 file:// spec 都指向本仓库内真实存在的文件（搬目录会立刻报错）',
  fileSpecs.length > 0 && relSpecs.length === 0 && missing.length === 0 && outside.length === 0,
  `spec=${fileSpecs.length} 相对=${JSON.stringify(relSpecs)} 缺失=${JSON.stringify(missing)} 越界=${JSON.stringify(outside)}`,
)

/* --------------------------------------- V-C4 features 目录与清单一致 */

const featureDirs = fs
  .readdirSync(path.join(ROOT, 'features'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
const specDirs = specPaths.map((p) => path.basename(path.dirname(p))).sort()
const unlisted = featureDirs.filter((d) => !specDirs.includes(d))
check(
  'V-C4',
  '每个 features/ 目录都在模式清单里（加了目录忘了加行会报）',
  unlisted.length === 0 && specDirs.length === featureDirs.length,
  `目录=${JSON.stringify(featureDirs)} 清单=${JSON.stringify(specDirs)} 未挂=${JSON.stringify(unlisted)}`,
)

/* ------------------------------------------------ V-C2 用户配置零侵入 */

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

/* -------------------------------------------------- V-G 中间件管线（真装配） */

const middlewareFeature = await import(new URL('../features/middleware/index.js', import.meta.url).href)
const approvalFeature = await import(new URL('../features/bypass-approval/index.js', import.meta.url).href)

const modDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mods-'))
const addMod = (text) =>
  `export default { id: 'mod:verify', field: 'sections', priority: 10, apply(sections) { return [{ name: 'mod:verify', text: ${JSON.stringify(text)}, interpolate: false }, ...sections] } }\n`

const midHost = await newHost()
const midKey = {}
const midScope = createScope(midHost, midKey)
fs.writeFileSync(path.join(modDir, 'a-add.mjs'), addMod('MOD-ADD'), 'utf8')
await midScope.ctx.plugin(middlewareFeature, { dir: modDir, rescanMs: 0 })

const asm1 = await midHost.systemPrompt.assemble({ scope: midKey })
const mod1 = find(asm1.sections, 'mod:verify')
check(
  'V-G1',
  'mod 在预设 scope 的装配里生效（sections 被改写）',
  Boolean(mod1) && String(mod1.text) === 'MOD-ADD',
  `sections=${JSON.stringify(names(asm1.sections))}`,
)

await new Promise((r) => setTimeout(r, 20))
fs.writeFileSync(path.join(modDir, 'a-add.mjs'), addMod('MOD-ADD-SECOND-LONGER'), 'utf8')
const asm2 = await midHost.systemPrompt.assemble({ scope: midKey })
check(
  'V-G2',
  'mod 改文件即重载（mtime 指纹变了才重新 import）',
  String(find(asm2.sections, 'mod:verify')?.text) === 'MOD-ADD-SECOND-LONGER',
  `text=${JSON.stringify(find(asm2.sections, 'mod:verify')?.text)}`,
)

await new Promise((r) => setTimeout(r, 20))
fs.writeFileSync(
  path.join(modDir, 'b-boom.mjs'),
  "export default { id: 'mod:boom', field: 'sections', apply() { throw new Error('boom: 故意炸') } }\n",
  'utf8',
)
let asm3
let boomThrew = false
try {
  asm3 = await midHost.systemPrompt.assemble({ scope: midKey })
} catch {
  boomThrew = true
}
check(
  'V-G3',
  '一个 mod 抛错不影响装配，其余 mod 照常生效',
  !boomThrew && String(find(asm3?.sections, 'mod:verify')?.text) === 'MOD-ADD-SECOND-LONGER',
  boomThrew ? '装配被 mod 的异常打断' : `sections=${JSON.stringify(names(asm3?.sections))}`,
)

const cleanKey = {}
createScope(midHost, cleanKey)
const cleanAsm = await midHost.systemPrompt.assemble({ scope: cleanKey })
check(
  'V-G4',
  '不挂 middleware 的 scope 不受任何 mod 影响',
  find(cleanAsm.sections, 'mod:verify') === undefined,
  `sections=${JSON.stringify(names(cleanAsm.sections))}`,
)
fs.rmSync(modDir, { recursive: true, force: true })

/* ------------------------------------------------------ V-H 授信旁路判决 */

check(
  'V-H1',
  'allow 为空 = 全放（返回 allowed-once 接管该请求）',
  approvalFeature.decide({ enabled: true, allow: [] }, { toolName: 'bash' }) === 'allowed-once',
  String(approvalFeature.decide({ enabled: true, allow: [] }, { toolName: 'bash' })),
)

check(
  'V-H2',
  '通配符命中才放，未命中的交回宿主（null = next()）',
  approvalFeature.decide({ enabled: true, allow: ['bash*', 'pwsh'] }, { toolName: 'bash' }) === 'allowed-once' &&
    approvalFeature.decide({ enabled: true, allow: ['bash*', 'pwsh'] }, { toolName: 'fs_write' }) === null &&
    approvalFeature.decide({ enabled: true, allow: ['bash*'] }, { toolName: 'BASH-persistent' }) === 'allowed-once',
  '',
)

check(
  'V-H3',
  'enabled: false 一键收手（任何请求都不接管）',
  approvalFeature.decide({ enabled: false, allow: [] }, { toolName: 'bash' }) === null,
  '',
)

/* ------------------------------------------- V-I hooks 判决旁路（真瀑布） */

const { scopeTarget } = await import(url('dsh-scope/lib/index.js'))
const hooksFeature = await import(new URL('../features/hooks-bypass/index.js', import.meta.url).href)

// 一个只有「宿主判决」的 host：它 claim deny，不调 next，正如真的 hooks 桥。
const denyHost = new Context()
await denyHost.plugin({
  name: 'host-deny-probe',
  apply(c) {
    c.effect(
      () => c.on('tools/pre-execute', () => Promise.resolve({ kind: 'deny', reason: 'probe: 宿主 hooks 拦下' })),
      'probe.deny',
    )
  },
})

const dispatch = (key) =>
  denyHost.waterfall(scopeTarget({}, key), 'tools/pre-execute', { name: 'bash', arguments: {} }, () =>
    Promise.resolve({ kind: 'allow' }),
  )

const bareKey = {}
createScope(denyHost, bareKey)
const bareDecision = await dispatch(bareKey)
check(
  'V-I1',
  '对照组：没有 forge 的 scope，宿主 deny 原样生效',
  bareDecision?.kind === 'deny',
  `kind=${bareDecision?.kind}`,
)

const bypassKey = {}
const bypassScope = createScope(denyHost, bypassKey)
await bypassScope.ctx.plugin(hooksFeature, { enabled: true, invert: ['deny', 'ask'], tools: [] })
const bypassed = await dispatch(bypassKey)
check(
  'V-I2',
  'prepend + await next() 之后把 deny 反转成 allow',
  bypassed?.kind === 'allow',
  `kind=${bypassed?.kind}`,
)

const offKey = {}
const offScope = createScope(denyHost, offKey)
await offScope.ctx.plugin(hooksFeature, { enabled: false })
const offDecision = await dispatch(offKey)
check(
  'V-I3',
  'enabled: false 时判决不被改写',
  offDecision?.kind === 'deny',
  `kind=${offDecision?.kind}`,
)

check(
  'V-I4',
  '纯判决函数：工具过滤与 kind 过滤都咬得住',
  hooksFeature.rewrite({ kind: 'deny' }, { name: 'bash' }, { tools: ['bash*'] })?.kind === 'allow' &&
    hooksFeature.rewrite({ kind: 'deny' }, { name: 'fs_write' }, { tools: ['bash*'] })?.kind === 'deny' &&
    hooksFeature.rewrite({ kind: 'cancel' }, { name: 'bash' }, {})?.kind === 'cancel' &&
    hooksFeature.rewrite({ kind: 'allow' }, { name: 'bash' }, {})?.kind === 'allow',
  '',
)

/* ------------------------------------ V-J 身份行剥离 / 能力协议（真装配） */

const identityFeature = await import(new URL('../features/identity-strip/index.js', import.meta.url).href)
const capFeature = await import(new URL('../features/capability-protocol/index.js', import.meta.url).href)
const CAP_MARK = '能力使用协议'

const idHost = await newHost()
const idKey = {}
const idScope = createScope(idHost, idKey)
await idScope.ctx.plugin(identityFeature, { name: 'harness:identity', text: '' })
const idAsm = await idHost.systemPrompt.assemble({ scope: idKey })

const ctlKey = {}
createScope(idHost, ctlKey)
const ctlAsm = await idHost.systemPrompt.assemble({ scope: ctlKey })

const idSection = find(idAsm.sections, 'harness:identity')
const ctlSection = find(ctlAsm.sections, 'harness:identity')

check(
  'V-J1',
  '同名 scoped 段覆盖全局：身份行在自己的 scope 里被剥成空',
  Boolean(idSection) && String(idSection.text) === '' && String(ctlSection?.text || '').length > 0,
  `本 scope=${JSON.stringify(idSection?.text)} 对照=${JSON.stringify(ctlSection?.text?.slice(0, 24))}`,
)

// 同一个 scope 里再挂 persona(complete) 与能力协议，验两件事：
// ① complete 会把同名段吃掉（文档里写的互斥），② context 不受影响。
await forge.scope.ctx.plugin(identityFeature, { name: 'harness:identity', text: '' })
await forge.scope.ctx.plugin(capFeature, { file: 'data/capability-protocol.md', order: 50 })
const enriched = await sp.assemble({ scope: forge.key })

check(
  'V-J2',
  'persona 设 complete 时身份行剥离是空操作（sections 被收成单段）',
  enriched.sections.length === 1 && enriched.sections[0].name === 'forge:persona',
  `sections=${JSON.stringify(names(enriched.sections))}`,
)

check(
  'V-J3',
  '能力协议走 context，complete 收尾之后依然在',
  String(find(enriched.contexts, 'forge:capability-protocol')?.text || '').includes(CAP_MARK) &&
    find(otherAsm.contexts, 'forge:capability-protocol') === undefined,
  `contexts=${JSON.stringify(names(enriched.contexts))}`,
)

/* ------------------------------------------------- V-K 请求失败兜底重试 */

const retryFeature = await import(new URL('../features/request-retry/index.js', import.meta.url).href)

const retryHost = new Context()
const retryKey = {}
const retryScope = createScope(retryHost, retryKey)
await retryScope.ctx.plugin(retryFeature, { enabled: true, max: 2, permanent: [] })

const errorDispatch = (payload) =>
  retryHost.waterfall(scopeTarget({}, retryKey), 'agent/request-error', payload, () => Promise.resolve(undefined))

const transient = await errorDispatch({ agent: { id: 'a' }, turn: 1, step: 1, failure: { code: 'NETWORK', message: 'x' } })
check(
  'V-K1',
  '宿主放弃时，瞬时失败被兜底成 retry',
  transient?.kind === 'retry',
  `decision=${JSON.stringify(transient)}`,
)

const retryTwice = await errorDispatch({ agent: { id: 'a' }, turn: 1, step: 1, failure: { code: 'NETWORK', message: 'x' } })
const retryThird = await errorDispatch({ agent: { id: 'a' }, turn: 1, step: 1, failure: { code: 'NETWORK', message: 'x' } })
check(
  'V-K2',
  '按 (agent,turn,step) 计预算：第三次不再补（max=2）',
  retryTwice?.kind === 'retry' && retryThird === undefined,
  `second=${JSON.stringify(retryTwice)} third=${JSON.stringify(retryThird)}`,
)

check(
  'V-K3',
  '终态错误码不重试（HTTP 401 / 码名含 PERMISSION / 自带 permanent 表）',
  retryFeature.decide({ failure: { code: 'X', status: 401 } }, { max: 2 }) === undefined &&
    retryFeature.decide({ failure: { code: 'PERMISSION_DENIED' } }, { max: 2 }) === undefined &&
    retryFeature.decide({ failure: { code: 'MINE' } }, { max: 2, permanent: ['MINE'] }) === undefined,
  '',
)

check(
  'V-K4',
  '已 abort 的请求不重试；enabled:false 不干预',
  retryFeature.decide({ failure: { code: 'NETWORK' }, signal: { aborted: true } }, { max: 2 }) === undefined &&
    retryFeature.decide({ failure: { code: 'NETWORK' } }, { enabled: false, max: 2 }) === undefined,
  '',
)

/* --------------------------------------------------- V-L 自动续跑判决链 */

const cont = await import(new URL('../features/auto-continue/index.js', import.meta.url).href)
const ON = { enabled: true, max: 3 }
const idle = (extra) => ({ status: 'idle', kind: 'error', used: 0, ...extra })

check(
  'V-L1',
  '默认关闭；开启后异常结束 + 空闲才续',
  cont.shouldContinue(idle({}), { enabled: false }) === false &&
    cont.shouldContinue(idle({}), ON) === true &&
    cont.shouldContinue(idle({ status: 'running' }), ON) === false,
  '',
)

check(
  'V-L2',
  '没干完才续：completed / blocked / forked 不续；有挂起输入或新人类发言也不续',
  ['completed', 'blocked', 'forked'].every((kind) => cont.shouldContinue(idle({ kind }), ON) === false) &&
    cont.shouldContinue(idle({ inboxBusy: true }), ON) === false &&
    cont.shouldContinue(idle({ freshHuman: true }), ON) === false,
  '',
)

check(
  'V-L3',
  '外部取消全挡 —— 含 purge 因取错字段而漏掉的 parent / hook / disposed',
  cont.EXTERNAL_CANCEL_CAUSES.every(
    (cause) => cont.shouldContinue(idle({ kind: 'aborted', reason: { cause: { kind: cause } } }), ON) === false,
  ) && cont.shouldContinue(idle({ cancelled: true }), ON) === false,
  '',
)

check(
  'V-L4',
  '不可续表挡住终态码与 RATE_LIMIT；拿不到错误码时放行',
  cont.shouldContinue(idle({ errorCode: 'AUTH' }), ON) === false &&
    cont.shouldContinue(idle({ errorCode: 'RATE_LIMIT' }), ON) === false &&
    cont.shouldContinue(idle({ errorCode: '' }), ON) === true &&
    cont.NO_CONTINUE_CODES.includes('TRANSPORT'),
  '',
)

check(
  'V-L5',
  '预算与去重：用满不续；同一 seq 不重复续',
  cont.shouldContinue(idle({ used: 3 }), ON) === false &&
    cont.shouldContinue(idle({ seq: 7, lastSeq: 7 }), ON) === false &&
    cont.shouldContinue(idle({ seq: 8, lastSeq: 7 }), ON) === true,
  '',
)

/* ---------------------------------------- V-M inject 声明形状静态检查 */

// Cordis 的 inject 只有两种合法形状：字符串数组，或 name → config 的 map。
// 写成 { required: [...], optional: [...] } 会被当成要等名为 required/optional
// 的服务 —— 预设直接卡在 "waiting for required, optional"，而且不报错。
// 这条是那次事故的回归断言。
{
  const featureDirs = fs
    .readdirSync(path.join(ROOT, 'features'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(ROOT, 'features', d.name, 'index.js'))
  const bad = []
  for (const file of featureDirs) {
    const text = fs.readFileSync(file, 'utf8')
    const m = text.match(/export\s+const\s+inject\s*=\s*(\{[^}]*\})/)
    if (!m) continue
    // 对象形式只允许 name → config；出现这两个键就是写错了。
    if (/\b(required|optional)\s*:/.test(m[1])) bad.push(path.basename(path.dirname(file)))
  }
  check(
    'V-M',
    'inject 声明形状合法（不得出现 { required, optional } —— Cordis 会当成服务名）',
    bad.length === 0,
    `写错：${JSON.stringify(bad)}`,
  )
}

/* ------------------------------------------- V-N 每个 feature 都能真的挂上 */

// inject 写错、或依赖了预设里不存在的服务时，插件会永远停在 "waiting for ..."
// 且不报错 —— 预设整个卡死。这里对每个 feature 做一次带超时的挂载，
// 把这类问题从"开新会话才发现"变成"跑 verify 就发现"。
{
  const dirs = fs
    .readdirSync(path.join(ROOT, 'features'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  const stuck = []
  for (const dirName of dirs) {
    const mod = await import(new URL(`../features/${dirName}/index.js`, import.meta.url).href)
    const h = await newHost()
    const k = {}
    const sc = createScope(h, k)
    const mounted = await Promise.race([
      sc.ctx.plugin(mod, {}).then(() => true),
      new Promise((r) => setTimeout(() => r(false), 500)),
    ])
    if (!mounted) stuck.push(dirName)
    await sc.dispose()
  }
  check('V-N', '每个 feature 都能在只有 systemPrompt 的宿主上挂载完成（不 waiting）', stuck.length === 0, `卡住：${JSON.stringify(stuck)}`)
}

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
