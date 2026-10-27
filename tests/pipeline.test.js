import test from 'node:test'
import assert from 'node:assert/strict'
import { Pipeline, normalize, LAYERS } from '../core/pipeline.js'

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

test('normalize 拒绝非法形状', () => {
  assert.throws(() => normalize(null), /必须是对象/)
  assert.throws(() => normalize({ layer: 'L1', apply() {} }), /id/)
  assert.throws(() => normalize({ id: 'x', layer: 'L9', apply() {} }), /layer/)
  assert.throws(() => normalize({ id: 'x', layer: 'L1' }), /apply/)
})

test('normalize 补默认值并按 origin 决定 optional', () => {
  const builtin = normalize({ id: 'a', layer: 'L1', apply() {} }, 'builtin')
  assert.equal(builtin.hook, 'assemble')
  assert.equal(builtin.field, 'sections')
  assert.equal(builtin.optional, false)
  assert.equal(builtin.priority, 1000)

  const mod = normalize({ id: 'b', layer: 'L2', apply() {} }, 'mod')
  assert.equal(mod.hook, 'pre-step')
  assert.equal(mod.optional, true)

  // 显式 optional:false 覆盖 origin 默认
  assert.equal(normalize({ id: 'c', layer: 'L1', apply() {}, optional: false }, 'mod').optional, false)
})

test('priority 决定执行顺序，低者先跑', async () => {
  const journal = fakeJournal()
  const pipeline = new Pipeline({ journal })
  const order = []
  pipeline.register({ id: 'late', layer: 'L1', priority: 900, apply: (v) => (order.push('late'), v) })
  pipeline.register({ id: 'early', layer: 'L1', priority: 100, apply: (v) => (order.push('early'), v) })

  await pipeline.run('assemble', [], {}, { only: new Set(['L1']) })
  assert.deepEqual(order, ['early', 'late'])
})

test('only 只跑指定层', async () => {
  const journal = fakeJournal()
  const pipeline = new Pipeline({ journal })
  const seen = []
  pipeline.register({ id: 'l1', layer: 'L1', apply: (v) => (seen.push('L1'), v) })
  pipeline.register({ id: 'l1b', layer: 'L1b', apply: (v) => (seen.push('L1b'), v) })

  await pipeline.run('assemble', [], {}, { only: new Set(['L1b']) })
  assert.deepEqual(seen, ['L1b'])
})

test('closedLayers 跳过该层全部中间件', async () => {
  const journal = fakeJournal()
  const pipeline = new Pipeline({ journal })
  pipeline.register({ id: 'l2', layer: 'L2', apply: (v) => [...v, 'x'] })

  const kept = await pipeline.run('pre-step', [], {}, { closedLayers: new Set(['L2']) })
  assert.deepEqual(kept, [])

  const applied = await pipeline.run('pre-step', [], {}, { closedLayers: new Set() })
  assert.deepEqual(applied, ['x'])
})

test('middleware 覆盖开关优先于 everything', async () => {
  const journal = fakeJournal()
  const pipeline = new Pipeline({ journal, overrides: { off: false, forced: true } })
  pipeline.register({ id: 'off', layer: 'L1', apply: (v) => [...v, 'off'] })
  pipeline.register({ id: 'forced', layer: 'L1', apply: (v) => [...v, 'forced'] })

  const out = await pipeline.run('assemble', [], {}, { only: new Set(['L1']) })
  assert.deepEqual(out, ['forced'])
})

test('同 id 覆盖而不重复执行', async () => {
  const journal = fakeJournal()
  const pipeline = new Pipeline({ journal })
  pipeline.register({ id: 'same', layer: 'L1', priority: 10, apply: (v) => [...v, 'v1'] })
  pipeline.register({ id: 'same', layer: 'L1', priority: 10, apply: (v) => [...v, 'v2'] })

  const out = await pipeline.run('assemble', [], {}, { only: new Set(['L1']) })
  assert.deepEqual(out, ['v2'])
})

test('内置中间件抛错会冒泡，mod 中间件抛错只记日志', async () => {
  const journal = fakeJournal()
  const pipeline = new Pipeline({ journal })
  pipeline.register({ id: 'core:boom', layer: 'L1', apply: () => { throw new Error('boom') } }, 'builtin')
  await assert.rejects(() => pipeline.run('assemble', [], {}, { only: new Set(['L1']) }), /boom/)
  assert.equal(journal.records.at(-1).op, 'error')

  const journal2 = fakeJournal()
  const pipeline2 = new Pipeline({ journal: journal2 })
  pipeline2.register({ id: 'mod:boom', layer: 'L1', apply: () => { throw new Error('boom') } }, 'mod')
  const out = await pipeline2.run('assemble', ['keep'], {}, { only: new Set(['L1']) })
  assert.deepEqual(out, ['keep'])
  assert.equal(journal2.records.at(-1).op, 'error')
})

test('非数组返回值被拒绝', async () => {
  const journal = fakeJournal()
  const pipeline = new Pipeline({ journal })
  pipeline.register({ id: 'mod:bad', layer: 'L1', apply: () => 'nope' }, 'mod')
  const out = await pipeline.run('assemble', ['keep'], {}, { only: new Set(['L1']) })
  assert.deepEqual(out, ['keep'])
  assert.match(journal.records.at(-1).note, /必须返回数组/)

  const strict = new Pipeline({ journal: fakeJournal() })
  strict.register({ id: 'core:bad', layer: 'L1', apply: () => 'nope' }, 'builtin')
  await assert.rejects(() => strict.run('assemble', [], {}, { only: new Set(['L1']) }), /必须返回数组/)
})

test('null/undefined 返回值表示不改', async () => {
  const journal = fakeJournal()
  const pipeline = new Pipeline({ journal })
  pipeline.register({ id: 'skip', layer: 'L1', apply: () => undefined })
  pipeline.register({ id: 'skip2', layer: 'L1', apply: () => null })
  assert.deepEqual(await pipeline.run('assemble', ['a'], {}, { only: new Set(['L1']) }), ['a'])
})

test('runSync 拒绝 Promise', () => {
  const journal = fakeJournal()
  const pipeline = new Pipeline({ journal })
  pipeline.register({ id: 'core:async', layer: 'L3', apply: async (v) => v }, 'builtin')
  assert.throws(() => pipeline.runSync('history', [], {}, { only: new Set(['L3']) }), /必须同步/)
})

test('activeOn 与 list 反映真实状态', () => {
  const journal = fakeJournal()
  const pipeline = new Pipeline({ journal, overrides: { 'mod:x': false } })
  pipeline.register({ id: 'core:p', layer: 'L1', apply: (v) => v }, 'builtin')
  pipeline.register({ id: 'mod:x', layer: 'L1', apply: (v) => v }, 'mod')

  assert.equal(pipeline.activeOn('L1', 'assemble'), true)
  assert.equal(pipeline.activeOn('L1b', 'assemble'), false)

  const list = pipeline.list()
  assert.equal(list.length, 2)
  assert.equal(list.find((x) => x.id === 'mod:x').enabled, false)
  assert.equal(pipeline.countByLayer().L1, 2)
})

test('LAYERS 映射与 hook 一一对应', () => {
  assert.equal(LAYERS.L1.hook, 'assemble')
  assert.equal(LAYERS.L1b.hook, 'assemble')
  assert.equal(LAYERS.L2.hook, 'pre-step')
  assert.equal(LAYERS.L3.hook, 'history')
})
