/**
 * 提示词来源链：promptFile → forge/rules/<active>.md → cwd 的 AGENTS.md/CLAUDE.md → prompts/base.md
 *
 * 与 purge 的差别是刻意的：这里**只读**用户的 AGENTS.md / CLAUDE.md，绝不写。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig } from '../core/config.js'
import {
  activeRule,
  clearCache,
  listRules,
  readIfExists,
  resolvePrompt,
  rulesDir,
  setActiveRule,
} from '../core/source.js'
import { adviceReport, ADVICE } from '../core/advice.js'

function tmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `forge-${label}-`))
}

function cfgWith(dshHome, extra = {}) {
  return { ...resolveConfig(extra, {}), dshHome }
}

test('无任何来源时回落到 prompts/base.md', () => {
  const home = tmp('home')
  try {
    clearCache()
    const out = resolvePrompt(cfgWith(home), { cwd: tmp('empty') })
    assert.equal(out.source, 'default')
    assert.ok(out.text.length > 0)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('promptFile 优先级最高', () => {
  const home = tmp('home')
  const dir = tmp('file')
  try {
    const file = path.join(dir, 'custom.md')
    fs.writeFileSync(file, 'CUSTOM PROMPT\n')
    const out = resolvePrompt(cfgWith(home, { promptFile: file }), { cwd: dir })
    assert.equal(out.source, 'file')
    assert.match(out.text, /CUSTOM PROMPT/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('规则集：写入、激活、被 resolve 选中', () => {
  const home = tmp('rules')
  try {
    const dir = rulesDir(home)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'alpha.md'), 'ALPHA\n')
    fs.writeFileSync(path.join(dir, 'beta.md'), 'BETA\n')

    assert.deepEqual(listRules(home), ['alpha', 'beta'])
    assert.equal(activeRule(home), '')

    setActiveRule(home, 'beta')
    clearCache()
    assert.equal(activeRule(home), 'beta')

    const out = resolvePrompt(cfgWith(home), { cwd: '' })
    assert.equal(out.source, 'rule:beta')
    assert.match(out.text, /BETA/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('激活的规则文件被删掉时，链继续往下走', () => {
  const home = tmp('rules-gone')
  try {
    setActiveRule(home, 'ghost')
    clearCache()
    const out = resolvePrompt(cfgWith(home), { cwd: '' })
    assert.equal(out.source, 'default')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('cwd 的 AGENTS.md 优先于 CLAUDE.md，且 base 仍兜底', () => {
  const home = tmp('home')
  const cwd = tmp('cwd')
  try {
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'CLAUDE RULE\n')
    clearCache()
    let out = resolvePrompt(cfgWith(home), { cwd })
    assert.equal(out.source, 'cwd:CLAUDE.md')

    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'AGENTS RULE\n')
    clearCache()
    out = resolvePrompt(cfgWith(home), { cwd })
    assert.equal(out.source, 'cwd:AGENTS.md')
    assert.match(out.text, /AGENTS RULE/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('promptSource=file 时跳过 cwd 与规则，只认 promptFile/base', () => {
  const home = tmp('home2')
  const cwd = tmp('cwd2')
  try {
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'AGENTS RULE\n')
    clearCache()
    const out = resolvePrompt(cfgWith(home, { promptSource: 'file' }), { cwd })
    assert.equal(out.source, 'default')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('本插件从不写用户的 AGENTS.md / CLAUDE.md', () => {
  const home = tmp('home3')
  const cwd = tmp('cwd3')
  try {
    const agents = path.join(cwd, 'AGENTS.md')
    fs.writeFileSync(agents, 'ORIGINAL\n')
    const before = fs.readFileSync(agents, 'utf8')
    resolvePrompt(cfgWith(home), { cwd })
    resolvePrompt(cfgWith(home, { promptFile: path.join(home, 'x.md') }), { cwd })
    assert.equal(fs.readFileSync(agents, 'utf8'), before)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('readIfExists 返回 null 而不是抛', () => {
  assert.equal(readIfExists(path.join(os.tmpdir(), 'definitely-missing-forge-file.md')), null)
})

/* ------------------------------------------------------------------ L0 建议项 */

test('建议项覆盖 4 个 purge 曾用补丁改的配置点', () => {
  const ids = ADVICE.map((a) => a.id)
  for (const id of ['sandbox-mode', 'approval-policy', 'read-caps', 'subagent-depth']) {
    assert.ok(ids.includes(id), `建议项缺少 ${id}`)
  }
})

test('adviceReport 在拿不到宿主服务时 current 为 null，但 how 仍可用', () => {
  const report = adviceReport(null)
  assert.equal(report.length, ADVICE.length)
  for (const item of report) {
    assert.ok(item.how.length > 0, `${item.id} 没有给改法`)
    assert.ok(item.source.length > 0, `${item.id} 没有标来源`)
    assert.ok(item.current === null || typeof item.current === 'string')
  }
})

test('adviceReport 能从宿主服务读到当前值', () => {
  const ctx = {
    get(name) {
      if (name === 'sandboxPolicy') return { defaultMode: 'danger-full-access' }
      if (name === 'approval') return { config: { policy: 'ask' } }
      return undefined
    },
  }
  const report = adviceReport(ctx)
  assert.equal(report.find((r) => r.id === 'sandbox-mode').current, 'danger-full-access')
  assert.equal(report.find((r) => r.id === 'approval-policy').current, 'ask')
})
