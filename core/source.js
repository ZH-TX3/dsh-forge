/**
 * 提示词正文来源 —— **一条优先级链**，第一个非空胜出。
 *
 *   1. config.promptFile                  显式指定的文件（最高优先）
 *   2. $DSH_HOME/forge/rules/<active>.md   多套提示词，靠 active.json 切换
 *   3. <cwd>/AGENTS.md                     项目级（可选开）
 *   4. <cwd>/CLAUDE.md                     项目级（可选开）
 *   5. prompts/base.md                     插件自带默认
 *
 * 与 purge 的规则集相比刻意做了减法：
 *   · 不往用户的 AGENTS.md / CLAUDE.md **写**任何东西（purge 会覆盖它们）
 *   · 不设 strict/fallback/always 三档 workspace 策略（那是第二套真相）
 *   · 只读、只选、只报告来源
 *
 * 全部按 mtime 缓存，改文件即时生效。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promptPath } from './config.js'

const cache = new Map()

/** 读文件，带 mtime 缓存。返回 null 表示文件不存在。 */
export function readIfExists(file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return null
    const hit = cache.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text
    const text = fs.readFileSync(file, 'utf8')
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, text })
    return text
  } catch {
    return null
  }
}

/** 规则目录：$DSH_HOME/forge/rules */
export function rulesDir(dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  return path.join(dshHome, 'forge', 'rules')
}

/** 列出可用规则（不含扩展名）。 */
export function listRules(dshHome) {
  const dir = rulesDir(dshHome)
  let names = []
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.md'))
      .map((n) => n.slice(0, -3))
      .sort()
  } catch {
    return []
  }
  return names
}

/** 当前激活的规则 id（active.json 里的一行）。 */
export function activeRule(dshHome) {
  const file = path.join(rulesDir(dshHome), 'active.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const id = String(raw?.active || '').trim()
    return id && !id.includes('..') && !id.includes('/') && !id.includes('\\') ? id : ''
  } catch {
    return ''
  }
}

export function setActiveRule(dshHome, id) {
  const dir = rulesDir(dshHome)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'active.json')
  const payload = `${JSON.stringify({ active: String(id || ''), at: new Date().toISOString() }, null, 2)}\n`
  fs.writeFileSync(`${file}.tmp`, payload, 'utf8')
  fs.renameSync(`${file}.tmp`, file)
  return readIfExists(file) !== null
}

function nonEmpty(text) {
  return typeof text === 'string' && text.trim().length > 0 ? text : ''
}

/**
 * 解析本轮提示词正文。
 * @param {object} cfg resolveConfig() 的结果
 * @param {{cwd?:string}} [opts]
 * @returns {{text:string, from:string, source:string, exists:boolean}}
 */
export function resolvePrompt(cfg, opts = {}) {
  const dshHome = cfg?.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const cwd = String(opts.cwd || '').trim()

  // 1. 显式文件（仅当 config 真的指定了 promptFile —— 否则这里会命中默认 base.md，链就断了）
  const explicitFile = String(cfg?.promptFile || '').trim()
  if (explicitFile) {
    const explicit = promptPath(cfg)
    const fromExplicit = nonEmpty(readIfExists(explicit))
    if (fromExplicit) return { text: fromExplicit, from: explicit, source: 'file', exists: true }
  }

  // 2. 多套规则里激活的那一套
  const active = activeRule(dshHome)
  if (active) {
    const file = path.join(rulesDir(dshHome), `${active}.md`)
    const fromRule = nonEmpty(readIfExists(file))
    if (fromRule) return { text: fromRule, from: file, source: `rule:${active}`, exists: true }
  }

  // 3. / 4. 项目级 AGENTS.md、CLAUDE.md（只读，不动用户的文件）
  if (cfg?.promptSource !== 'file' && cwd) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = path.join(cwd, name)
      const fromCwd = nonEmpty(readIfExists(file))
      if (fromCwd) return { text: fromCwd, from: file, source: `cwd:${name}`, exists: true }
    }
  }

  // 5. 插件自带默认
  const fallback = promptPath({ promptFile: '' })
  const text = nonEmpty(readIfExists(fallback))
  return { text: text || '', from: fallback, source: text ? 'default' : 'none', exists: Boolean(text) }
}

export function clearCache() {
  cache.clear()
}
