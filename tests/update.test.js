/**
 * 自更新：只测**离线的部分** —— 校验闸与配置解析。
 * 真正下载走网络，不放进单测（会让 CI 依赖 GitHub 可达性）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_REPO, COPY_NAMES, applyUpdate, repoFromPackage, updateSettings } from '../core/update.js'

test('默认仓库是当前账号下的 dsh-forge', () => {
  assert.equal(DEFAULT_REPO, 'ZH-TX3/dsh-forge')
})

test('repo 优先级：config > package.json > 默认', () => {
  assert.equal(updateSettings({}, {}).repo, DEFAULT_REPO)
  assert.equal(
    updateSettings({}, { repository: { url: 'git+https://github.com/someone/other.git' } }).repo,
    'someone/other',
  )
  assert.equal(updateSettings({ update: { repo: 'explicit/repo' } }, {}).repo, 'explicit/repo')
})

test('repoFromPackage 解析常见写法', () => {
  assert.equal(repoFromPackage({ repository: 'https://github.com/a/b' }), 'a/b')
  assert.equal(repoFromPackage({ repository: { url: 'git+https://github.com/a/b.git' } }), 'a/b')
  assert.equal(repoFromPackage({}), DEFAULT_REPO)
})

test('token 来自 env，config 可覆盖', () => {
  assert.equal(updateSettings({}, {}, { GITHUB_TOKEN: 't1' }).token, 't1')
  assert.equal(updateSettings({}, {}, { GH_TOKEN: 't2' }).token, 't2')
  assert.equal(updateSettings({ update: { token: 't3' } }, {}, { GITHUB_TOKEN: 't1' }).token, 't3')
  assert.equal(updateSettings({}, {}, {}).token, '')
})

test('sha256 归一化为小写并去空白', () => {
  assert.equal(updateSettings({ update: { sha256: '  ABCDEF  ' } }, {}).sha256, 'abcdef')
})

test('未钉 sha256 时 apply 直接拒绝（且不触网）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-upd-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-forge', version: '0.1.0' }))
  try {
    await assert.rejects(
      () => applyUpdate(updateSettings({}, {}), { targetDir: dir }),
      /未配置 update\.sha256/,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('目标目录不是插件目录时拒绝', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-notplugin-'))
  try {
    await assert.rejects(
      () => applyUpdate(updateSettings({}, {}, { GITHUB_TOKEN: 'x' }), { targetDir: dir }),
      /不是插件目录/,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('COPY_NAMES 覆盖全部运行时代码，且不含 node_modules', () => {
  for (const name of ['index.js', 'core', 'layers', 'patches', 'prompts', 'scripts', 'package.json']) {
    assert.ok(COPY_NAMES.includes(name), `COPY_NAMES 缺少 ${name}`)
  }
  assert.ok(!COPY_NAMES.some((n) => n.includes('node_modules')))
})
