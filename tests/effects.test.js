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

test('continue-turn 打开后注册 agent/status', () => {
  const ctx = fakeCtx()
  const config = resolveConfig({ effects: { 'continue-turn': true } }, {})
  const out = installEffects({ ctx, config, journal: fakeJournal() })
  const row = out.results.find((r) => r.id === 'continue-turn')
  assert.equal(row.status, 'installed')
  assert.ok((ctx.hooks.get('agent/status') || []).length > 0)
})

test('continue-turn：异常结束 + payload 带 agent → 补发 followup', async () => {
  const ctx = fakeCtx()
  const config = resolveConfig({ effects: { 'continue-turn': { enabled: true, delayMs: 0 } } }, {})
  installEffects({ ctx, config, journal: fakeJournal() })
  const handler = (ctx.hooks.get('agent/status') || [])[0]

  const sent = []
  const agent = {
    status: 'idle',
    inbox: { hasPending: () => false },
    followup(message) {
      sent.push(message)
    },
    session: {
      id: 's1',
      events: [{ type: 'turn/end', seq: 10, data: { turn: 1, reason: { kind: 'error' } } }],
    },
  }

  // 关键：宿主 agentEvents() 会把 agent 融进 payload（dsh-agent/lib/index.js:243）
  handler({ status: 'idle', agent })
  await new Promise((r) => setTimeout(r, 10))

  assert.equal(sent.length, 1)
  assert.equal(sent[0].role, 'user')
  assert.equal(sent[0].source.kind, 'dsh-forge')
})

test('continue-turn：用户主动取消不续', async () => {
  const ctx = fakeCtx()
  const config = resolveConfig({ effects: { 'continue-turn': { enabled: true, delayMs: 0 } } }, {})
  installEffects({ ctx, config, journal: fakeJournal() })
  const handler = (ctx.hooks.get('agent/status') || [])[0]

  const sent = []
  handler({
    status: 'idle',
    agent: {
      status: 'idle',
      inbox: { hasPending: () => false },
      followup: (m) => sent.push(m),
      session: { id: 's2', events: [{ type: 'turn/end', seq: 1, data: { reason: { kind: 'aborted', reason: 'user' } } }] },
    },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(sent.length, 0)
})

test('continue-turn：正常结束不续', async () => {
  const ctx = fakeCtx()
  const config = resolveConfig({ effects: { 'continue-turn': { enabled: true, delayMs: 0 } } }, {})
  installEffects({ ctx, config, journal: fakeJournal() })
  const handler = (ctx.hooks.get('agent/status') || [])[0]

  const sent = []
  handler({
    status: 'idle',
    agent: {
      status: 'idle',
      inbox: { hasPending: () => false },
      followup: (m) => sent.push(m),
      session: { id: 's3', events: [{ type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } }] },
    },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(sent.length, 0)
})

test('continue-turn：turn/end 之后用户已发言则不续', async () => {
  const ctx = fakeCtx()
  const config = resolveConfig({ effects: { 'continue-turn': { enabled: true, delayMs: 0 } } }, {})
  installEffects({ ctx, config, journal: fakeJournal() })
  const handler = (ctx.hooks.get('agent/status') || [])[0]

  const sent = []
  handler({
    status: 'idle',
    agent: {
      status: 'idle',
      inbox: { hasPending: () => false },
      followup: (m) => sent.push(m),
      session: {
        id: 's4',
        events: [
          { type: 'turn/end', seq: 1, data: { reason: { kind: 'error' } } },
          { type: 'user/message', seq: 2, data: { source: { kind: 'user' } } },
        ],
      },
    },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(sent.length, 0)
})

test('continue-turn：预算用完不再续', async () => {
  const ctx = fakeCtx()
  const config = resolveConfig({ effects: { 'continue-turn': { enabled: true, delayMs: 0, max: 1 } } }, {})
  installEffects({ ctx, config, journal: fakeJournal() })
  const handler = (ctx.hooks.get('agent/status') || [])[0]

  const sent = []
  const agent = {
    status: 'idle',
    inbox: { hasPending: () => false },
    followup: (m) => sent.push(m),
    session: { id: 's5', events: [{ type: 'turn/end', seq: 7, data: { reason: { kind: 'error' } } }] },
  }
  handler({ status: 'idle', agent })
  handler({ status: 'idle', agent })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(sent.length, 1, 'max=1 只发一次')
})

test('continue-turn：payload 没有 agent 时静默跳过', async () => {
  const ctx = fakeCtx()
  const config = resolveConfig({ effects: { 'continue-turn': { enabled: true, delayMs: 0 } } }, {})
  installEffects({ ctx, config, journal: fakeJournal() })
  const handler = (ctx.hooks.get('agent/status') || [])[0]
  // 不应抛
  handler({ status: 'idle' })
  await new Promise((r) => setTimeout(r, 10))
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
