/**
 * EFFECTS（行为注入）—— 与 LAYERS 并列的第二张声明表。
 * 重点测预算与「不抢下游决策」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EFFECTS, EFFECT_IDS, describeEffects, installEffects } from '../core/effects.js'
import { resolveConfig } from '../core/config.js'

const fakeCtx = () => {
  const hooks = new Map()
  return {
    hooks,
    on(name, fn) {
      if (!hooks.has(name)) hooks.set(name, [])
      hooks.get(name).push(fn)
      return () => {}
    },
  }
}

const fakeJournal = () => ({ records: [], record(e) { this.records.push(e) } })

function install(configOverrides = {}) {
  const ctx = fakeCtx()
  const journal = fakeJournal()
  const config = resolveConfig(configOverrides, {})
  const out = installEffects({ ctx, config, journal })
  const handler = (ctx.hooks.get('agent/request-error') || [])[0] || null
  return { ctx, journal, config, handler, results: out.results }
}

test('效果表结构完整，且默认值符合预期', () => {
  assert.ok(Object.isFrozen(EFFECTS))
  for (const id of EFFECT_IDS) {
    assert.equal(typeof EFFECTS[id].install, 'function', `${id} 缺 install`)
    assert.equal(typeof EFFECTS[id].title, 'string')
  }
  assert.equal(EFFECTS['request-retry'].default, true)
  assert.equal(EFFECTS['continue-turn'].default, false)
})

test('request-retry 默认安装', () => {
  const { handler, results } = install()
  assert.ok(handler, '应注册 agent/request-error')
  assert.equal(results.find((r) => r.id === 'request-retry').status, 'installed')
})

test('永久错误码不重试', async () => {
  const { handler } = install()
  const out = await handler({ failure: { code: 'UNAUTHORIZED' }, turn: 1, step: 1 }, async () => undefined)
  assert.equal(out, undefined)
})

test('瞬时错误按预算重试，用完就放行', async () => {
  const { handler } = install({ effects: { 'request-retry': { enabled: true, max: 2 } } })
  const payload = { failure: { code: 'TRANSPORT' }, turn: 1, step: 1, agent: { session: { id: 's1' } } }
  const call = () => handler(payload, async () => undefined)

  assert.deepEqual(await call(), { kind: 'retry' })
  assert.deepEqual(await call(), { kind: 'retry' })
  assert.equal(await call(), undefined, '第 3 次超预算，放行给宿主抛错')
})

test('不同 step 各自独立计预算', async () => {
  const { handler } = install({ effects: { 'request-retry': { enabled: true, max: 1 } } })
  const base = { failure: { code: 'TRANSPORT' }, turn: 1, agent: { session: { id: 's1' } } }
  assert.deepEqual(await handler({ ...base, step: 1 }, async () => undefined), { kind: 'retry' })
  assert.equal(await handler({ ...base, step: 1 }, async () => undefined), undefined)
  assert.deepEqual(await handler({ ...base, step: 2 }, async () => undefined), { kind: 'retry' })
})

test('下游已经决定 retry 时原样透传，不重复计数', async () => {
  const { handler } = install()
  const out = await handler({ failure: { code: 'TRANSPORT' }, turn: 4, step: 2 }, async () => ({ kind: 'retry' }))
  assert.deepEqual(out, { kind: 'retry' })
})

test('max=0 视为关闭', () => {
  const { handler, results } = install({ effects: { 'request-retry': { enabled: true, max: 0 } } })
  assert.equal(handler, null)
  assert.equal(results.find((r) => r.id === 'request-retry').status, 'off')
})

test('enabled=false 不注册', () => {
  const { handler } = install({ effects: { 'request-retry': false } })
  assert.equal(handler, null)
})

test('continue-turn 明确报告 unsupported，不假装能用', () => {
  const { results } = install({ effects: { 'continue-turn': true } })
  const row = results.find((r) => r.id === 'continue-turn')
  assert.equal(row.status, 'unsupported')
  assert.match(row.detail, /agent/)
})

test('describeEffects 同时支持布尔与对象写法', () => {
  const bool = describeEffects(resolveConfig({ effects: { 'request-retry': false } }, {})).find(
    (e) => e.id === 'request-retry',
  )
  assert.equal(bool.enabled, false)

  const obj = describeEffects(resolveConfig({ effects: { 'request-retry': { enabled: true, max: 7 } } }, {})).find(
    (e) => e.id === 'request-retry',
  )
  assert.equal(obj.enabled, true)
  assert.equal(obj.options.max, 7)
})
