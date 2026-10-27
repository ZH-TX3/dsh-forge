import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { closedLayers, layerOpen, modsPath, promptPath, resolveConfig } from '../core/config.js'
import { listModFiles, loadMods, modDirStatus } from '../core/loader.js'
import { anyContains, clip, fingerprint, messageText, replaceMessageText, fromLf, toLf } from '../core/text.js'

test('默认配置', () => {
  const cfg = resolveConfig({}, {})
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.promptOrder, -1001)
  assert.deepEqual(cfg.stripSections, ['harness:identity'])
  assert.deepEqual(cfg.layers, { L1: true, L1b: true, L2: false, L3: false })
  assert.equal(cfg.l0.sourcePatch.enabled, false)
  assert.equal(cfg.l0.capabilities['auto-approve'], false)
})

test('宿主 config 覆盖默认值', () => {
  const cfg = resolveConfig({ enabled: false, layers: { L2: true }, promptOrder: 50 }, {})
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.layers.L2, true)
  assert.equal(cfg.layers.L1, true) // 未提及的层保留默认
  assert.equal(cfg.promptOrder, 50)
})

test('环境变量优先于 config', () => {
  const cfg = resolveConfig({ enabled: true, layers: { L3: false } }, { DSH_FORGE_ENABLED: '0', DSH_FORGE_L3: '1' })
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.layers.L3, true)
})

test('能力开关按配置开启，未提及的保持默认关', () => {
  const cfg = resolveConfig({ l0: { capabilities: { 'auto-approve': true } } }, {})
  assert.equal(cfg.l0.capabilities['auto-approve'], true)
  assert.equal(cfg.l0.capabilities['suppress-host-crash'], false)
})

test('能力开关支持 DSH_FORGE_CAP_* 环境变量覆盖', () => {
  const cfg = resolveConfig({}, { DSH_FORGE_CAP_AUTO_APPROVE: '1' })
  assert.equal(cfg.l0.capabilities['auto-approve'], true)
})

test('update 段有默认值且 sha256 为空表示禁止 apply', () => {
  const cfg = resolveConfig({}, {})
  assert.equal(cfg.update.ref, 'main')
  assert.equal(cfg.update.sha256, '')
})

test('stripSections 支持逗号字符串', () => {
  const cfg = resolveConfig({ stripSections: 'a, b ,c' }, {})
  assert.deepEqual(cfg.stripSections, ['a', 'b', 'c'])
})

test('layerOpen / closedLayers 一致', () => {
  const cfg = resolveConfig({ layers: { L1: true, L1b: false, L2: false, L3: true } }, {})
  assert.equal(layerOpen(cfg, 'L1'), true)
  assert.equal(layerOpen(cfg, 'L1b'), false)
  assert.deepEqual([...closedLayers(cfg)].sort(), ['L1b', 'L2'])
})

test('enabled=false 时所有层视为关闭', () => {
  const cfg = resolveConfig({ enabled: false }, {})
  assert.equal(layerOpen(cfg, 'L1'), false)
  assert.equal(closedLayers(cfg).size, 4)
})

test('promptPath / modsPath 默认指向插件自带目录', () => {
  const cfg = resolveConfig({}, {})
  assert.match(promptPath(cfg).replace(/\\/g, '/'), /dsh-forge\/prompts\/base\.md$/)
  assert.match(modsPath(cfg).replace(/\\/g, '/'), /dsh-forge\/mods$/)
})

test('promptPath / modsPath 支持绝对路径', () => {
  const abs = process.platform === 'win32' ? 'C:\\tmp\\p.md' : '/tmp/p.md'
  const cfg = resolveConfig({ promptFile: abs, modsDir: path.dirname(abs) }, {})
  assert.equal(promptPath(cfg), abs)
  assert.equal(modsPath(cfg), path.dirname(abs))
})

test('loader 跳过下划线开头的样例文件', () => {
  const dir = path.join(process.cwd(), 'mods')
  const files = listModFiles(dir)
  assert.ok(files.every((f) => !path.basename(f).startsWith('_')))
  const status = modDirStatus(dir)
  assert.equal(status.exists, true)
  assert.ok(status.files.includes('README.md') === false)
})

test('loadMods 对不存在的目录返回空且不抛', async () => {
  const { specs, errors } = await loadMods(path.join(process.cwd(), '__no_such_dir__'))
  assert.deepEqual(specs, [])
  assert.deepEqual(errors, [])
})

test('toLf / fromLf 往返', () => {
  const [lf, had] = toLf('a\r\nb')
  assert.equal(lf, 'a\nb')
  assert.equal(had, true)
  assert.equal(fromLf(lf, had), 'a\r\nb')
  assert.equal(fromLf('a\nb', false), 'a\nb')
})

test('fingerprint 同时校验首尾', () => {
  const fp = fingerprint('HEAD-middle-TAIL', 4, 4)
  assert.equal(fp.head, 'HEAD')
  assert.equal(fp.tail, 'TAIL')
  assert.equal(fp.contains('xxHEAD-middle-TAILxx'), true)
  assert.equal(fp.contains('HEAD-middle-xxxxx'), false)
  assert.equal(fingerprint('').contains('anything'), true)
})

test('anyContains 对段数组工作', () => {
  const sections = [{ name: 'a', text: 'hello world' }]
  assert.equal(anyContains(sections, 'hello world'), true)
  assert.equal(anyContains(sections, 'nope'), false)
  assert.equal(anyContains(sections, ''), true)
})

test('messageText / replaceMessageText 兼容 string 与 block', () => {
  assert.equal(messageText('abc'), 'abc')
  assert.equal(messageText({ content: [{ type: 'text', text: 'x' }, { type: 'image' }] }), 'x')

  const replaced = replaceMessageText({ role: 'user', content: [{ type: 'text', text: 'old' }] }, 'new')
  assert.equal(replaced.content[0].text, 'new')
  assert.equal(replaceMessageText('old', 'new'), 'new')
})

test('clip 压平空白并截断', () => {
  assert.equal(clip('  a\n\n b  ', 10), 'a b')
  assert.equal(clip('abcdef', 3), 'abc…')
  assert.equal(clip(null), '')
})
