#!/usr/bin/env node
/**
 * mods 管线真跑 —— 在**真实**的 `data/mods/` 与真宿主编排上验证热插拔。
 *
 * 与 verify 的分工：
 *   verify      用临时目录证明机制对（幂等、隔离、出错不炸）
 *   mods-check  用真目录证明**你现在装的这套 mod 真的在跑**，且改/删即时生效
 *
 *   npm run mods
 *
 * 会往 `data/mods/` 写一个 99-probe.mjs 再删掉（finally 保证清理）。
 * 若目录里已经有 99-probe.mjs，直接拒绝运行 —— 不覆盖别人的文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MODS_DIR = path.join(ROOT, 'data', 'mods')
const PROBE = path.join(MODS_DIR, '99-probe.mjs')

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
  console.error('[mods] 未找到宿主 @deepseek-ai 目录（用 DSH_FORGE_AIBASE 指定）')
  process.exit(1)
}
if (fs.existsSync(PROBE)) {
  console.error(`[mods] ${PROBE} 已存在，拒绝覆盖。先处理它再跑。`)
  process.exit(1)
}

const url = (p) => pathToFileURL(path.join(aiBase, ...p.split('/'))).href
const { Context } = await import(url('cordis/lib/index.js'))
const { default: SystemPrompt } = await import(url('dsh-system-prompt/lib/index.js'))
const { createScope } = await import(url('dsh-scope/lib/index.js'))
const middleware = await import(new URL('../features/middleware/index.js', import.meta.url).href)

const host = new Context()
await host.plugin(SystemPrompt, {})
const key = {}
const scope = createScope(host, key)

// plugin() 返回 Fiber，拿不到 apply 的返回值 —— 薄包装捕获一次。
let api
await scope.ctx.plugin(
  { name: 'mods-capture', inject: ['systemPrompt'], apply: (c, cfg) => void (api = middleware.apply(c, cfg)) },
  { dir: 'data/mods', rescanMs: 0 },
)

const snapshot = async () => {
  const asm = await host.systemPrompt.assemble({ scope: key })
  return {
    mods: api.mods.map((m) => `${m.id}@${m.priority}`),
    sections: asm.sections.map((s) => `${s.name}:${String(s.text).length}`),
  }
}
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass: Boolean(pass), detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? `  ↳ ${detail}` : ''}`)
}

try {
  const base = await snapshot()
  console.log(`\n真实目录 ${MODS_DIR}`)
  console.log(`已装 mod：${base.mods.length ? base.mods.join(', ') : '(空)'}\n`)
  check('目录里的 mod 都被加载了（与文件一一对应）', base.mods.length === fs.readdirSync(MODS_DIR).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).length, JSON.stringify(base.mods))

  fs.writeFileSync(
    PROBE,
    "export default { id: 'mod:probe', field: 'sections', priority: 10, apply(s) { return [{ name: 'mod:probe', text: 'PROBE-V1', interpolate: false }, ...s] } }\n",
    'utf8',
  )
  await settle()
  const added = await snapshot()
  check('丢进文件即生效', added.sections.some((n) => n === 'mod:probe:8'), JSON.stringify(added.sections))

  fs.writeFileSync(
    PROBE,
    "export default { id: 'mod:probe', field: 'sections', priority: 10, apply(s) { return [{ name: 'mod:probe', text: 'PROBE-V2-LONGER', interpolate: false }, ...s] } }\n",
    'utf8',
  )
  await settle()
  const edited = await snapshot()
  check('改内容即重载（mtime 指纹进 import URL）', edited.sections.some((n) => n === 'mod:probe:15'), JSON.stringify(edited.sections))

  fs.writeFileSync(
    PROBE,
    "export default { id: 'mod:dup', field: 'sections', priority: 10, apply(s) { const t = 'DUPLICATE-TEXT'; return [...s, { name: 'mod:a', text: t, interpolate: false }, { name: 'mod:b', text: t, interpolate: false }] } }\n",
    'utf8',
  )
  await settle()
  const dup = await snapshot()
  const twins = dup.sections.filter((n) => n.startsWith('mod:a') || n.startsWith('mod:b'))
  check('01-dedupe 真的吃掉了重复段', twins.length === 1, JSON.stringify(dup.sections))
} finally {
  // 不论成败都清掉探针，目录回到原状。
  if (fs.existsSync(PROBE)) fs.rmSync(PROBE)
  await settle()
}

const back = await snapshot()
const files = fs.readdirSync(MODS_DIR).filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
check('删文件回原状（无残留）', back.mods.length === files.length, JSON.stringify(back.mods))

const failed = results.filter((r) => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} 通过${failed ? `，${failed} 失败` : ''}\n`)
process.exit(failed ? 1 : 0)
