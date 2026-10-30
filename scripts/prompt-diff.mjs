#!/usr/bin/env node
/**
 * 渲染「锻造模式」与「不选模式」两份系统提示词，并给出差异。
 *
 * 为什么要有它：
 *   verify 证明机制对，mods-check 证明数据活；但没人能回答
 *   「选了锻造模式，模型看到的东西到底变了什么」。
 *   这个脚本用真宿主的 renderPrompt 把人设、规则、协议一次渲染出来，
 *   让「感觉不到变化」变成一个可以看的 diff。
 *
 *   npm run prompt
 *   npm run prompt -- --raw      # 不做省略，全文打印
 *
 * 配置来源是 cordis.patch.yml（唯一真相源），不另抄一份。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const raw = process.argv.includes('--raw')
const LIMIT = 60

/* ------------------------------------------------------- 极简 patch 解析 */

function parseScalar(text) {
  const t = text.trim()
  if (t === '' || t === '[]') return t === '[]' ? [] : ''
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+$/.test(t)) return Number(t)
  if (t.startsWith('[')) {
    return t
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
  }
  return t.replace(/^['"]|['"]$/g, '')
}

/** 只认本仓库 cordis.patch.yml 的形状：`- id: 名字` + name + 可选 config 块。 */
function readPresetPlugins(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const rows = []
  let current = null
  let inConfig = false
  let configIndent = 0

  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()

    const rowMatch = body.match(/^-\s+id:\s*(\S+)$/)
    if (rowMatch && indent <= 12) {
      current = { id: rowMatch[1], name: '', config: {} }
      rows.push(current)
      inConfig = false
      continue
    }
    if (!current) continue

    const kv = body.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!kv) continue
    const [, key, value] = kv

    if (key === 'name' && !inConfig) {
      current.name = parseScalar(value)
      continue
    }
    if (key === 'config' && value === '') {
      inConfig = true
      configIndent = indent
      continue
    }
    if (inConfig && indent > configIndent) {
      current.config[key] = parseScalar(value)
      continue
    }
    if (indent <= configIndent) inConfig = false
  }

  return rows.filter((r) => r.name.startsWith('@local/dsh-forge/'))
}

/* ---------------------------------------------------------------- 宿主 */

function findAiBase() {
  const ok = (dir) => Boolean(dir) && fs.existsSync(path.join(dir, 'dsh-system-prompt', 'lib', 'index.js'))
  const roots = [
    process.env.DSH_FORGE_AIBASE,
    path.dirname(process.execPath),
    'D:/nvm/v24.18.1',
    path.join(process.env.APPDATA || '', 'npm'),
  ].filter(Boolean)
  for (const root of roots) {
    const base = path.resolve(root)
    if (ok(base)) return base
    for (const rel of ['node_modules/@deepseek-ai', 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai']) {
      const dir = path.join(base, ...rel.split('/'))
      if (ok(dir)) return dir
    }
  }
  return null
}

const aiBase = findAiBase()
if (!aiBase) {
  console.error('[prompt] 未找到宿主 @deepseek-ai 目录')
  process.exit(1)
}
const url = (p) => pathToFileURL(path.join(aiBase, ...p.split('/'))).href
const { Context } = await import(url('cordis/lib/index.js'))
const { default: SystemPrompt, renderPrompt } = await import(url('dsh-system-prompt/lib/index.js'))
const { createScope } = await import(url('dsh-scope/lib/index.js'))

/* ---------------------------------------------------------------- 装配 */

const rows = readPresetPlugins(path.join(ROOT, 'cordis.patch.yml'))
if (rows.length === 0) {
  console.error('[prompt] 没从 cordis.patch.yml 里解析到任何 @local/dsh-forge 行')
  process.exit(1)
}

/**
 * 对照基线必须用**部署态**的 system-prompt 配置，否则比的是空壳。
 * 真值从 `dsh --profile <p> --dump-config` 读，读不到才退回已知默认。
 */
function readDeployedPersona() {
  const profile = process.env.DSH_PROFILE || 'web'
  try {
    const out = execFileSync('dsh', ['--profile', profile, '--dump-config'], {
      encoding: 'utf8',
      timeout: 90_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    })
    const NL = String.fromCharCode(10)
    const block =
      out.split(new RegExp(NL + '(?=- id: )')).find((chunk) => chunk.includes("dsh-system-prompt")) || ''
    const pick = (key) => {
      for (const line of block.split(NL)) {
        const at = line.indexOf(key + ':')
        if (at === -1) continue
        const value = line.slice(at + key.length + 1).trim()
        return value.replace(/^['"]/, '').replace(/['"]$/, '')
      }
      return undefined
    }
    return {
      personaPrefix: pick('personaPrefix') ?? 'You are a coding agent powered by the {{model}} model.',
      personaSuffix: pick('personaSuffix') ?? 'Your working directory is {{cwd}}.',
      from: `dsh --profile ${profile} --dump-config`,
    }
  } catch {
    return {
      personaPrefix: 'You are a coding agent powered by the {{model}} model.',
      personaSuffix: 'Your working directory is {{cwd}}.',
      from: '内置默认（dump-config 读取失败）',
    }
  }
}

const deployed = readDeployedPersona()
const host = new Context()
await host.plugin(SystemPrompt, {
  personaPrefix: deployed.personaPrefix,
  personaSuffix: deployed.personaSuffix,
})

// 对照：不挂任何 forge 模块的 scope（= 其它模式的处境）
// 部署态人设里带 {{model}} / {{cwd}}，没有 provider 时 renderPrompt 会抛
// unknown prompt variable。这里补两个占位 provider —— 只为让渲染跑通，
// 真机上这两个值由 llm / 会话提供。
host.systemPrompt.variable('model', () => '<model>')
host.systemPrompt.variable('cwd', () => '<cwd>')

const bareKey = {}
createScope(host, bareKey)
const bareAsm = await host.systemPrompt.assemble({ scope: bareKey })

// 锻造模式
const forgeKey = {}
const forgeScope = createScope(host, forgeKey)
const failures = []
for (const row of rows) {
  const rel = row.name.replace('@local/dsh-forge/', '')
  const file = path.join(ROOT, ...rel.split('/'))
  if (!fs.existsSync(file)) {
    failures.push(`${row.id}: 文件不存在 ${rel}`)
    continue
  }
  try {
    const mod = await import(pathToFileURL(file).href)
    const plugin = { name: mod.name ?? row.id, inject: mod.inject ?? [], apply: mod.apply }
    const mounted = await Promise.race([
      forgeScope.ctx.plugin(plugin, row.config).then(() => true, () => false),
      new Promise((r) => setTimeout(() => r(false), 800)),
    ])
    if (!mounted) failures.push(`${row.id}: 挂载超时（多半在 waiting for 某个服务）`)
  } catch (error) {
    failures.push(`${row.id}: ${error?.message || error}`)
  }
}
const forgeAsm = await host.systemPrompt.assemble({ scope: forgeKey })

/* ---------------------------------------------------------------- 输出 */

const forgeText = renderPrompt(forgeAsm)
const bareText = renderPrompt(bareAsm)

const head = (text) => {
  const lines = text.split('\n')
  return raw || lines.length <= LIMIT ? text : [...lines.slice(0, LIMIT), `…（还有 ${lines.length - LIMIT} 行，用 --raw 看全文）`].join('\n')
}

console.log(`\n宿主：${aiBase}`)
console.log(`配置：${rows.length} 个能力模块来自 cordis.patch.yml\n`)

console.log('═'.repeat(72))
console.log(`【锻造模式】系统提示词  ${Buffer.byteLength(forgeText, 'utf8')} 字节 / ${forgeText.split('\n').length} 行`)
console.log('═'.repeat(72))
console.log(head(forgeText) || '(空)')

console.log(`\n${'═'.repeat(72)}`)
console.log(`【对照：不选模式】系统提示词  ${Buffer.byteLength(bareText, 'utf8')} 字节 / ${bareText.split('\n').length} 行`)
console.log('═'.repeat(72))
console.log(head(bareText) || '(空)')

const ctxNames = (asm) => asm.contexts.map((c) => `${c.name} (${String(c.text).length} 字符)`)
console.log(`\n【 contexts 】`)
console.log(`  锻造模式: ${ctxNames(forgeAsm).join(', ') || '(无)'}`)
console.log(`  对照    : ${ctxNames(bareAsm).join(', ') || '(无)'}`)

const onlyForge = forgeText.split('\n').filter((l) => l.trim() && !bareText.includes(l))
const onlyBare = bareText.split('\n').filter((l) => l.trim() && !forgeText.includes(l))
console.log(`\n【 差异 】只在锻造模式出现的行 ${onlyForge.length} 条，只在对照出现的行 ${onlyBare.length} 条`)
for (const line of onlyForge.slice(0, raw ? 999 : 12)) console.log(`  + ${line.slice(0, 100)}`)
for (const line of onlyBare.slice(0, raw ? 999 : 8)) console.log(`  - ${line.slice(0, 100)}`)

if (failures.length > 0) {
  console.log(`\n⚠ 挂载问题 ${failures.length} 条：`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('')
