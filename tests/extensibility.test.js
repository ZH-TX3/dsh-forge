/**
 * 拓展性测试：证明「加一层 / 加一个钩子」是**数据变更**，不是代码变更。
 *
 * 这些用例完全绕开 index.js —— 用自定义的 LAYERS 表直接驱动 Pipeline + runner。
 * 如果加层需要改核心代码，这里就跑不通。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { HOOKS, LAYERS, LAYER_IDS, groupFields, hookHasLayers, hookIsSync } from '../core/hooks.js'
import { Pipeline, normalize } from '../core/pipeline.js'
import { createRunner } from '../core/runner.js'
import { closedLayers, layerOpen, resolveConfig } from '../core/config.js'
import { apply } from '../index.js'
import { useTempHome } from './helpers.js'

// layerMeta() 不依赖开关，但 apply() 会读 state；摊一个临时 home 保持隔离。
const HOME = useTempHome({ enabled: true })
process.on('exit', () => HOME.restore())

const fakeJournal = () => ({
  touches: [],
  records: [],
  touch(hook) {
    this.touches.push(hook)
  },
  record(entry) {
    this.records.push(entry)
  },
})

/** 造一个带额外层的数据表 —— 模拟「以后想加一层」的场景。 */
const EXTENDED = Object.freeze({
  ...LAYERS,
  L4: { hook: 'assemble', field: 'tools', defaultOn: true, sync: false, title: '工具清单' },
  L5: { hook: 'pre-step', field: 'messages', defaultOn: true, sync: false, title: '审批文案' },
})

test('核心层表本身是冻结的（防止运行时被意外改写）', () => {
  assert.ok(Object.isFrozen(LAYERS))
  assert.ok(Object.isFrozen(HOOKS))
})

test('groupFields 按字段分组，同字段多层共存', () => {
  const groups = groupFields('assemble', LAYERS)
  assert.deepEqual([...groups.keys()], ['sections', 'contexts'])
  assert.deepEqual(groups.get('sections'), ['L1'])
  assert.deepEqual(groups.get('contexts'), ['L1b'])

  const extended = groupFields('assemble', EXTENDED)
  assert.deepEqual([...extended.keys()], ['sections', 'contexts', 'tools'])
  assert.deepEqual(extended.get('tools'), ['L4'])
})

test('同一字段挂两层时两个都在组里', () => {
  const two = Object.freeze({
    A: { hook: 'assemble', field: 'sections', defaultOn: true, sync: false },
    B: { hook: 'assemble', field: 'sections', defaultOn: true, sync: false },
  })
  assert.deepEqual(groupFields('assemble', two).get('sections'), ['A', 'B'])
})

test('hookHasLayers / hookIsSync', () => {
  assert.equal(hookHasLayers('assemble'), true)
  assert.equal(hookHasLayers('nonexistent'), false)
  assert.equal(hookIsSync('history'), true)
  assert.equal(hookIsSync('assemble'), false)
})

test('新增一层只需要加数据行：Pipeline 接受自定义层表', () => {
  const pipeline = new Pipeline({ journal: fakeJournal(), layers: EXTENDED })
  const mw = pipeline.register(
    { id: 'mod:tools', layer: 'L4', apply: (tools) => [...tools, { name: 'injected' }] },
    'mod',
  )
  assert.equal(mw.hook, 'assemble')
  assert.equal(mw.field, 'tools')
})

test('未声明的层被拒绝，并给出已声明清单', () => {
  const pipeline = new Pipeline({ journal: fakeJournal(), layers: LAYERS })
  assert.throws(() => pipeline.register({ id: 'x', layer: 'L9', apply: (v) => v }, 'mod'), /未知 layer/)
  assert.throws(() => normalize({ id: 'x', layer: 'L9', apply: (v) => v }, 'mod', 0, LAYERS), /L1/)
})

test('自定义层的中间件真的会跑，且不影响同钩子的其它字段', async () => {
  const pipeline = new Pipeline({ journal: fakeJournal(), layers: EXTENDED })
  pipeline.register({ id: 'mod:tools', layer: 'L4', apply: (tools) => [...tools, 'TOOL'] }, 'mod')

  const runner = createRunner({
    pipeline,
    journal: fakeJournal(),
    forgeContext: (_host, extra) => ({ ...extra }),
    closedLayers: () => new Set(),
    layerEnabled: () => true,
    layers: EXTENDED,
  })

  const assembly = { sections: [{ name: 'a' }], contexts: [], tools: ['t0'] }
  const out = await runner.runObject('assemble', assembly, {})

  assert.deepEqual(out.tools, ['t0', 'TOOL'], 'L4 改到了 tools')
  assert.equal(out.sections, assembly.sections, 'L1 未注册 → sections 引用不变')
  assert.notEqual(out, assembly, '被改过 → 返回新对象')
})

test('runObject 在该钩子无活可干时返回原对象（引用相等）', async () => {
  const pipeline = new Pipeline({ journal: fakeJournal(), layers: EXTENDED })
  const runner = createRunner({
    pipeline,
    journal: fakeJournal(),
    forgeContext: () => ({}),
    closedLayers: () => new Set(),
    layerEnabled: (id) => id !== 'L4',
    layers: EXTENDED,
  })
  const assembly = { sections: [], contexts: [], tools: [] }
  assert.equal(await runner.runObject('assemble', assembly, {}), assembly)
})

test('isLive 只看配置，不看当前有没有已注册中间件', () => {
  const pipeline = new Pipeline({ journal: fakeJournal() })
  // 一条中间件都没注册，但 L1 层开着 → hook 仍应接线（否则 mods 异步加载会错过）
  const runner = createRunner({
    pipeline,
    journal: fakeJournal(),
    forgeContext: () => ({}),
    closedLayers: () => new Set(),
    layerEnabled: (id) => layerOpen(resolveConfig({}, {}), id),
  })
  assert.equal(runner.isLive('assemble'), true)
  assert.equal(runner.isLive('pre-step'), false, 'L2 默认关')
  assert.equal(runner.isLive('history'), false, 'L3 默认关')
})

test('配置默认值来自层表，不是硬编码', () => {
  const cfg = resolveConfig({}, {})
  for (const id of LAYER_IDS) assert.equal(cfg.layers[id], LAYERS[id].defaultOn)
  // 未出现的层按 defaultOn 兜底
  assert.equal(layerOpen(cfg, 'L4'), false)
  assert.equal(closedLayers(cfg).has('L4'), false, 'L4 不在层表里，不参与关闭集合')
})

test('status().layerMeta 让 UI 不必硬编码层名', () => {
  const hooks = new Map()
  const services = new Map()
  const ctx = {
    on(n, fn) {
      if (!hooks.has(n)) hooks.set(n, [])
      hooks.get(n).push(fn)
      return () => {}
    },
    inject() {},
    effect() {},
    provide(n, v) {
      services.set(n, v)
    },
    get() {},
  }
  apply(ctx, {})
  const meta = services.get('forge').layerMeta()

  assert.equal(meta.length, LAYER_IDS.length)
  assert.deepEqual(meta.map((m) => m.id), [...LAYER_IDS])
  for (const item of meta) {
    assert.equal(item.hook, LAYERS[item.id].hook)
    assert.equal(item.field, LAYERS[item.id].field)
    assert.equal(typeof item.title, 'string')
  }
})

test('新增钩子只需要在 HOOKS 加一行：形态由 mode 决定', () => {
  for (const hook of Object.values(HOOKS)) {
    assert.ok(['object', 'messages', 'session-method'].includes(hook.mode))
    assert.equal(typeof hook.install, 'function')
    assert.equal(typeof hook.event, 'string')
  }
})
