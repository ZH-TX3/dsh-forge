/**
 * 自更新 —— 绑 GitHub 仓库，但**必须带校验**。
 *
 * purge 的 update.js 从 codeload 拉 zip，先 rm -rf lib 再覆盖，
 * 无签名无哈希；失败即半升级。这里把方向反过来：
 *
 *   校验优先于便利。没有配置 sha256 就**只允许 check，不允许 apply**。
 *
 * 流程：
 *   1. 由 `ref` 解析出 commit sha（sha 是内容寻址的，不能悄悄换内容）
 *   2. 按 sha 下载 tar.gz（不是按 branch —— branch 会漂移）
 *   3. 算 sha256，与你在配置里钉住的值比对，不一致直接拒绝
 *   4. 解压到临时目录 → 备份现有插件目录 → 整体替换 → 失败回滚
 *
 * 配置（cordis.patch.yml）：
 *
 *   update:
 *     repo: ZH-TX3/dsh-forge
 *     ref: main
 *     sha256: ""          # 空 = 禁止 apply，只能 check
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

export const DEFAULT_REPO = 'ZH-TX3/dsh-forge'
const ALLOWED_HOSTS = new Set(['api.github.com', 'codeload.github.com', 'raw.githubusercontent.com'])

export const COPY_NAMES = [
  'index.js',
  'backend.js',
  'client.js',
  'core',
  'layers',
  'patches',
  'prompts',
  'mods',
  'scripts',
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'ARCHITECTURE.md',
]

function assertUrl(url) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error(`拒绝非 https：${url}`)
  if (!ALLOWED_HOSTS.has(parsed.hostname)) throw new Error(`拒绝未授权主机：${parsed.hostname}`)
  return url
}

/**
 * 私有仓库必须带 token，否则 GitHub API 返回 404（不是 403）—— 很容易误判成"仓库不存在"。
 * token 优先级：settings.token > GITHUB_TOKEN > GH_TOKEN。
 */
function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {}
}

async function get(url, headers = {}, token = '') {
  const res = await fetch(assertUrl(url), {
    headers: { 'user-agent': 'dsh-forge', ...authHeaders(token), ...headers },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} ${url}`)
  return res
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 从 package.json 的 repository 字段推默认仓库。 */
export function repoFromPackage(pkg) {
  const url = pkg?.repository?.url || pkg?.repository || ''
  const match = String(url).match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
  return match ? match[1] : DEFAULT_REPO
}

export function updateSettings(config = {}, pkg = {}, env = process.env) {
  const raw = config?.update || {}
  return {
    repo: String(raw.repo || repoFromPackage(pkg) || DEFAULT_REPO),
    ref: String(raw.ref || 'main'),
    sha256: String(raw.sha256 || '').trim().toLowerCase(),
    token: String(raw.token || env.GITHUB_TOKEN || env.GH_TOKEN || ''),
  }
}

/** ref → commit sha。 */
export async function resolveRef(repo, ref, token = '') {
  const res = await get(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    { accept: 'application/vnd.github+json' },
    token,
  )
  const data = await res.json()
  if (!data?.sha) throw new Error(`解析 ${repo}@${ref} 失败`)
  return String(data.sha)
}

/** 远端 package.json 里的版本号（判断是否落后）。 */
export async function remoteVersion(repo, sha, token = '') {
  const res = await get(`https://raw.githubusercontent.com/${repo}/${sha}/package.json`, {}, token).catch(() => null)
  if (!res) return ''
  try {
    const text = await res.text()
    return String(JSON.parse(text).version || '')
  } catch {
    return ''
  }
}

export function localVersion(dir) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '')
  } catch {
    return ''
  }
}

/**
 * 检查更新。只读，不下载归档。
 * @returns {Promise<{repo,ref,sha,remoteVersion,localVersion,behind,pinned,canApply}>}
 */
export async function checkUpdate(settings) {
  const sha = await resolveRef(settings.repo, settings.ref, settings.token)
  const version = await remoteVersion(settings.repo, sha, settings.token)
  return {
    repo: settings.repo,
    ref: settings.ref,
    sha,
    remoteVersion: version,
    localVersion: '',
    pinned: Boolean(settings.sha256),
    canApply: Boolean(settings.sha256),
  }
}

/**
 * 只下载并算出归档 sha256，不校验、不写盘。
 * 供 `update pin` 用：先拿到值，再写进配置，最后才 apply。
 */
export async function computeArchiveHash(settings) {
  const sha = await resolveRef(settings.repo, settings.ref, settings.token)
  const res = await get(`https://codeload.github.com/${settings.repo}/tar.gz/${sha}`, {}, settings.token)
  const buf = Buffer.from(await res.arrayBuffer())
  return { sha, sha256: sha256(buf), bytes: buf.length }
}

/** 按 sha 下载归档并校验 sha256。校验不过直接抛。 */
export async function fetchArchive(settings, sha) {
  const res = await get(`https://codeload.github.com/${settings.repo}/tar.gz/${sha}`, {}, settings.token)
  const buf = Buffer.from(await res.arrayBuffer())
  const actual = sha256(buf)
  if (!settings.sha256) {
    throw new Error(`未配置 update.sha256，拒绝下载应用（只允许 check）。本次归档 sha256 = ${actual}`)
  }
  if (actual !== settings.sha256) {
    throw new Error(`sha256 不匹配，已中止。期望 ${settings.sha256}，实际 ${actual}`)
  }
  return { buf, sha256: actual }
}

function extractTarGz(file, dest) {
  const run = spawnSync('tar', ['-xzf', file, '-C', dest], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
  if (run.status !== 0) throw new Error(`解压失败：${run.stderr || run.stdout || `exit ${run.status}`}`)
}

/**
 * 应用更新。
 * @param {object} settings
 * @param {{targetDir:string, dryRun?:boolean, log?:(s:string)=>void}} opts
 */
export async function applyUpdate(settings, opts) {
  const targetDir = path.resolve(opts.targetDir)
  const log = opts.log || (() => {})
  if (!fs.existsSync(path.join(targetDir, 'package.json'))) throw new Error(`不是插件目录：${targetDir}`)
  if (!settings.sha256) throw new Error('未配置 update.sha256，拒绝 apply')

  const sha = await resolveRef(settings.repo, settings.ref, settings.token)
  const { buf } = await fetchArchive(settings, sha)
  log(`归档校验通过 sha256=${settings.sha256}`)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-upd-'))
  const archive = path.join(tmp, 'pkg.tar.gz')
  fs.writeFileSync(archive, buf)
  extractTarGz(archive, tmp)

  const root = fs
    .readdirSync(tmp, { withFileTypes: true })
    .filter((ent) => ent.isDirectory())
    .map((ent) => path.join(tmp, ent.name))
    .find((dir) => fs.existsSync(path.join(dir, 'package.json')))
  if (!root) throw new Error('归档里没有 package.json')

  if (opts.dryRun) {
    fs.rmSync(tmp, { recursive: true, force: true })
    return { ok: true, dryRun: true, sha, from: localVersion(root), to: localVersion(targetDir) }
  }

  const backup = path.join(
    process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    'dsh-forge',
    'backup',
    `update-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  )
  fs.mkdirSync(backup, { recursive: true })
  fs.cpSync(targetDir, backup, { recursive: true, filter: (src) => !src.includes('node_modules') })
  log(`已备份到 ${backup}`)

  try {
    for (const name of COPY_NAMES) {
      const from = path.join(root, name)
      if (!fs.existsSync(from)) continue
      const to = path.join(targetDir, name)
      fs.rmSync(to, { recursive: true, force: true })
      fs.cpSync(from, to, { recursive: true })
    }
    return { ok: true, sha, backup, version: localVersion(targetDir) }
  } catch (error) {
    // 半升级是最坏情况：立刻从备份整体还原。
    try {
      fs.cpSync(backup, targetDir, { recursive: true, force: true })
    } catch {
      /* 还原也失败时把 backup 路径报出去 */
    }
    throw new Error(`更新失败并已尝试从 ${backup} 还原：${error?.message || error}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
