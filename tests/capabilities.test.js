/**
 * L0 能力表 + 源码补丁引擎 + L4 会话工装。
 *
 * 这里测的都是「安全闸」——因为这几个模块的价值几乎全在闸上：
 *   没有闸的源码补丁就是 purge 的老路。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  COST_LEVELS,
  describeCapabilities,
  installCapabilities,
  revertCapability,
} from '../core/capabilities.js'
import { applyPatch, diffLines, hostVersion, previewPatch, revertPatch, sha256, syntaxCheck } from '../core/patch.js'
import { resolveConfig } from '../core/config.js'
import { Journal } from '../core/journal.js'
import { readSession, redactSession, restoreSession, statSession, writeSession } from '../core/l4.js'

/* ------------------------------------------------------------------ 能力表 */

test('每项能力都声明了成本、默认值与说明', () => {
  assert.ok(Object.isFrozen(CAPABILITIES))
  for (const id of CAPABILITY_IDS) {
    const cap = CAPABILITIES[id]
    assert.ok(COST_LEVELS[cap.cost], `${id} 的 cost ${cap.cost} 不在成本表里`)
    assert.equal(typeof cap.default, 'boolean')
    assert.ok(cap.title && cap.detail, `${id} 缺少 title/detail`)
  }
})

test('能力默认全关', () => {
  const config = resolveConfig({}, {})
  for (const id of CAPABILITY_IDS) assert.equal(config.l0.capabilities[id], false, `${id} 默认应为关`)
  assert.equal(config.l0.sourcePatch.enabled, false)
})

test('describeCapabilities 反映开关与总闸', () => {
  const config = resolveConfig({ l0: { capabilities: { 'auto-approve': true } } }, {})
  const list = describeCapabilities(config)
  const auto = list.find((x) => x.id === 'auto-approve')
  assert.equal(auto.enabled, true)
  assert.equal(auto.cost, 'native')

  const patchCap = list.find((x) => x.needsSourcePatch)
  assert.ok(patchCap)
  assert.equal(patchCap.available, false, '总闸关着 → patch 类能力不可用')
})

test('installCapabilities：native 类开启后真的装上', () => {
  const registered = []
  const ctx = {
    on(name, fn) {
      registered.push(name)
      return () => {}
    },
  }
  const config = resolveConfig({ l0: { capabilities: { 'auto-approve': true } } }, {})
  const { results, disposers } = installCapabilities({ ctx, config, journal: new Journal() })

  assert.equal(results.find((r) => r.id === 'auto-approve').status, 'installed')
  assert.ok(registered.includes('approval/request'))
  assert.equal(disposers.length, 1)
})

test('installCapabilities：source-patch 类在总闸关闭时被挡住', () => {
  const config = resolveConfig({ l0: { capabilities: { 'escalation-ladder-bypass': true } } }, {})
  const { results } = installCapabilities({ ctx: {}, config, journal: new Journal(), patches: [] })
  const row = results.find((r) => r.id === 'escalation-ladder-bypass')
  assert.equal(row.status, 'blocked')
  assert.match(row.detail, /sourcePatch/)
})

test('installCapabilities：filesystem 类在宿主运行时不自动执行', () => {
  const config = resolveConfig(
    { l0: { sourcePatch: { enabled: true }, capabilities: { 'remove-doctor-supervisor': true } } },
    {},
  )
  const { results } = installCapabilities({ ctx: {}, config, journal: new Journal() })
  const row = results.find((r) => r.id === 'remove-doctor-supervisor')
  assert.equal(row.status, 'blocked')
})

test('revertCapability 对未知 id 与无 revert 的能力都有明确答复', () => {
  assert.equal(revertCapability('nope', {}).status, 'unknown-capability')
  assert.equal(revertCapability('auto-approve', {}).status, 'no-revert')
})

/* ------------------------------------------------------------------ 补丁引擎 */

/** 造一个假宿主目录：<root>/dsh/package.json + <root>/pkg/lib/index.js */
function makeFakeHost(source, version = '0.2.0-rc.2') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-host-'))
  fs.mkdirSync(path.join(root, 'dsh'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'dsh', 'package.json'),
    JSON.stringify({ name: 'dsh', version }),
    'utf8',
  )
  fs.mkdirSync(path.join(root, 'pkg', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'pkg', 'lib', 'index.js'), source, 'utf8')
  return root
}

const BASE_SOURCE = 'const a = 1;\nconst b = 2;\nconst c = 3;\n'
const SAMPLE_PATCH = {
  id: 'test-patch',
  file: 'pkg/lib/index.js',
  hostVersions: ['0.2.0-rc.2'],
  marker: '/* patched */',
  find: 'const b = 2;',
  replace: '/* patched */ const b = 42;',
}

test('hostVersion 从 dsh/package.json 读', () => {
  const root = makeFakeHost(BASE_SOURCE)
  try {
    assert.equal(hostVersion(root), '0.2.0-rc.2')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('preview 出 diff 但不写盘', () => {
  const root = makeFakeHost(BASE_SOURCE)
  try {
    const file = path.join(root, 'pkg', 'lib', 'index.js')
    const before = fs.readFileSync(file, 'utf8')
    const result = previewPatch(SAMPLE_PATCH, root)
    assert.equal(result.status, 'ok')
    assert.match(result.diff, /\+ \/\* patched \*\/ const b = 42;/)
    assert.equal(fs.readFileSync(file, 'utf8'), before, '文件未变')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('版本不匹配直接拒绝', () => {
  const root = makeFakeHost(BASE_SOURCE, '0.2.1')
  try {
    assert.equal(previewPatch(SAMPLE_PATCH, root).status, 'version-mismatch')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('find 不唯一时拒绝（禁止模糊替换）', () => {
  const root = makeFakeHost('const b = 2;\nconst b = 2;\n')
  try {
    assert.equal(previewPatch(SAMPLE_PATCH, root).status, 'find-not-unique')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('find 未命中时拒绝（宿主升级后的典型症状）', () => {
  const root = makeFakeHost('// 完全不同的源码\n')
  try {
    assert.equal(previewPatch(SAMPLE_PATCH, root).status, 'find-not-found')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('apply → 幂等 → revert 全链路', () => {
  const root = makeFakeHost(BASE_SOURCE)
  try {
    const file = path.join(root, 'pkg', 'lib', 'index.js')
    const original = fs.readFileSync(file, 'utf8')

    const applied = applyPatch(SAMPLE_PATCH, root)
    assert.equal(applied.applied, true)
    assert.ok(fs.existsSync(`${file}.forge.bak`))
    assert.match(fs.readFileSync(file, 'utf8'), /patched/)

    // 再打一次：marker 命中 → already，不重复替换
    const again = applyPatch(SAMPLE_PATCH, root)
    assert.equal(again.status, 'already')
    assert.equal(again.applied, false)
    assert.equal(fs.readFileSync(file, 'utf8').split('patched').length - 1, 1)

    const reverted = revertPatch(SAMPLE_PATCH, root)
    assert.equal(reverted.ok, true)
    assert.equal(fs.readFileSync(file, 'utf8'), original)
    assert.ok(!fs.existsSync(`${file}.forge.bak`))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('替换后语法错误时拒绝写入（这是 purge 缺失的那道闸）', () => {
  const root = makeFakeHost(BASE_SOURCE)
  try {
    const broken = { ...SAMPLE_PATCH, id: 'broken', replace: 'const b = ;;;' }
    const result = applyPatch(broken, root)
    assert.equal(result.status, 'syntax-error')
    assert.equal(result.applied, false)
    assert.equal(fs.readFileSync(path.join(root, 'pkg', 'lib', 'index.js'), 'utf8'), BASE_SOURCE)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('draft 补丁（空 find）返回 no-definition', () => {
  const root = makeFakeHost(BASE_SOURCE)
  try {
    const draft = { id: 'd', file: 'pkg/lib/index.js', hostVersions: ['0.2.0-rc.2'], find: '', replace: '' }
    assert.equal(previewPatch(draft, root).status, 'no-definition')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('syntaxCheck 认得出好代码与坏代码', () => {
  assert.equal(syntaxCheck('a.js', 'const x = 1').ok, true)
  assert.equal(syntaxCheck('a.js', 'const x = ').ok, false)
})

test('sha256 与 diffLines 基本行为', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const diff = diffLines('a\nb\nc', 'a\nB\nc')
  assert.match(diff, /- b/)
  assert.match(diff, /\+ B/)
})

/* ------------------------------------------------------------------ L4 会话工装 */

function makeSession(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sess-'))
  const file = path.join(dir, 'session.jsonl.zstd')
  const text = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(text, 'utf8')))
  return { dir, file }
}

const EVENTS = [
  { type: 'session', id: 's1', cwd: '/tmp/x' },
  { type: 'user/message', message: { role: 'user', content: 'password=hunter2 please' } },
  { type: 'assistant/message', message: { role: 'assistant', content: 'ok' } },
]

test('L4：读、统计、遮蔽、还原', () => {
  const { dir, file } = makeSession(EVENTS)
  try {
    const stat = statSession(file)
    assert.equal(stat.events, 3)
    assert.equal(stat.byType['user/message'], 1)

    // dry-run 不写盘
    const dry = redactSession(file, /hunter2/g, '[R]', { dryRun: true })
    assert.equal(dry.hits, 1)
    assert.equal(dry.written, undefined)
    assert.match(readSession(file).text, /hunter2/)

    // apply 写盘
    const applied = redactSession(file, /hunter2/g, '[R]', { dryRun: false })
    assert.equal(applied.written, true)
    assert.ok(!readSession(file).text.includes('hunter2'))
    assert.ok(readSession(file).text.includes('[R]'))

    // 还原
    const restored = restoreSession(file)
    assert.equal(restored.ok, true)
    assert.match(readSession(file).text, /hunter2/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('L4：没命中就不写盘', () => {
  const { dir, file } = makeSession(EVENTS)
  try {
    const result = redactSession(file, /nothing-here/g, '[R]', { dryRun: false })
    assert.equal(result.written, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('L4：writeSession 会做回读校验（缺 type 直接回滚）', () => {
  const { dir, file } = makeSession(EVENTS)
  try {
    assert.throws(() => writeSession(file, [{ id: 'no-type' }]), /缺少 type/)
    // 回滚后原内容还在
    assert.equal(statSession(file).events, 3)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('L4：多帧 zstd 必须全部解出（只解第一帧 = 静默截断）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-multi-'))
  const file = path.join(dir, 'session.jsonl.zstd')
  try {
    // DSH 的会话文件是追加写的多帧拼接。这里造两帧。
    const line1 = JSON.stringify(EVENTS[0]) + '\n'
    const rest = JSON.stringify(EVENTS[1]) + '\n' + JSON.stringify(EVENTS[2]) + '\n'
    fs.writeFileSync(
      file,
      Buffer.concat([
        zlib.zstdCompressSync(Buffer.from(line1, 'utf8')),
        zlib.zstdCompressSync(Buffer.from(rest, 'utf8')),
      ]),
    )

    // 先固定住「Node 原生只解第一帧」这个事实 —— 我们的实现不能依赖它。
    const naive = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
    assert.equal(naive.split('\n').filter(Boolean).length, 1, 'Node 原生确实只解第一帧')

    const stat = statSession(file)
    assert.equal(stat.frames, 2)
    assert.equal(stat.events, 3, '全部 3 条都要读出来')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('L4：写回是单帧，且能被重新读全', () => {
  const { dir, file } = makeSession(EVENTS)
  try {
    const { events } = readSession(file)
    writeSession(file, events)
    const raw = fs.readFileSync(file)
    let count = 0
    for (let i = 0; i + 4 <= raw.length; i += 1) {
      if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) count += 1
    }
    assert.equal(count, 1, '写回必须是单帧，宿主任何解码器都能读全')
    const after = statSession(file)
    assert.equal(after.frames, 1)
    assert.equal(after.events, EVENTS.length)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('L4：非 zstd 文件给出明确错误', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bad-'))
  const file = path.join(dir, 'x.jsonl.zstd')
  fs.writeFileSync(file, 'not zstd at all')
  try {
    assert.throws(() => readSession(file), /不是有效的 zstd/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
