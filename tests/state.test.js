/**
 * 运行时总开关。
 *
 * 语义：默认关；打开才改行为；关掉 = 四层改写 + 能力 + 效果全部停，
 * 配置不动，打开即恢复，不用重启。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearCache, isEnabled, readState, setEnabled, statePath, writeState } from '../core/state.js'
import { resolveConfig } from '../core/config.js'
import { Journal } from '../core/journal.js'
import { Pipeline } from '../core/pipeline.js'
import { createRunner } from '../core/runner.js'
import { apply } from '../index.js'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-state-'))
}

test('没有 state.json 时默认是关', () => {
  const home = tmpHome()
  try {
    clearCache()
    const st = readState(home)
    assert.equal(st.enabled, false, '装上插件不等于立刻改行为')
    assert.equal(st.exists, false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('打开后读回来是开，且写入时间被记录', () => {
  const home = tmpHome()
  try {
    clearCache()
    const out = setEnabled(home, true)
    assert.equal(out.enabled, true)
    const st = readState(home)
    assert.equal(st.enabled, true)
    assert.equal(st.exists, true)
    assert.match(st.at, /^\d{4}-\d{2}-\d{2}T/)
    assert.ok(fs.existsSync(statePath(home)))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('损坏的 state.json 退回安全默认（关），不抛', () => {
  const home = tmpHome()
  try {
    fs.mkdirSync(path.join(home, 'dsh-forge'), { recursive: true })
    fs.writeFileSync(statePath(home), '{ 这不是 json')
    clearCache()
    assert.equal(readState(home).enabled, false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('写入会立刻失效缓存（不用等 500ms）', () => {
  const home = tmpHome()
  try {
    clearCache()
    readState(home) // 先填缓存
    setEnabled(home, true)
    assert.equal(readState(home).enabled, true)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('isEnabled 同时看配置与开关', () => {
  const home = tmpHome()
  try {
    clearCache()
    assert.equal(isEnabled(home, resolveConfig({}, {})), false, '默认关')

    setEnabled(home, true)
    assert.equal(isEnabled(home, resolveConfig({}, {})), true)

    // 配置层关掉也等于不生效
    assert.equal(isEnabled(home, resolveConfig({ enabled: false }, {})), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('writeState 空 patch 不清掉已有关闭状态', () => {
  const home = tmpHome()
  try {
    clearCache()
    setEnabled(home, true)
    writeState(home, {})
    assert.equal(readState(home).enabled, true, '空 patch 不应重置开关')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ 管线闸 */

function makeRunner(isActive) {
  const journal = new Journal()
  const pipeline = new Pipeline({ journal })
  pipeline.register({ id: 'core:test', layer: 'L1', apply: (v) => [...v, 'CHANGED'] }, 'builtin')
  return createRunner({
    pipeline,
    journal,
    forgeContext: () => ({}),
    closedLayers: () => new Set(),
    layerEnabled: () => true,
    isActive,
  })
}

test('总开关关掉时 runObject / runMessages 原样返回', async () => {
  const off = makeRunner(() => false)
  const assembly = { sections: [{ name: 'a' }], contexts: [] }
  assert.equal(await off.runObject('assemble', assembly, {}), assembly, '应返回同一对象')
  assert.deepEqual(await off.runMessages('pre-step', ['m'], {}), ['m'])

  const on = makeRunner(() => true)
  assert.notEqual(await on.runObject('assemble', assembly, {}), assembly, '开的时候应该被改写')
})

test('总开关关掉时被包装的 session 方法原样返回', () => {
  let alive = true
  const runner = makeRunner(() => alive)
  const base = [{ role: 'user', content: 'x' }]
  const session = { id: 's', deriveMessages: () => base }
  runner.wrapSessionMethod('history', session, 'deriveMessages', Symbol.for('t'))

  assert.deepEqual(session.deriveMessages(), base)
  alive = false
  assert.deepEqual(session.deriveMessages(), base)
})

/* ------------------------------------------------------------------ 端到端 */

function makeCtx() {
  const hooks = new Map()
  const services = new Map()
  return {
    hooks,
    services,
    on(name, fn) {
      if (!hooks.has(name)) hooks.set(name, [])
      hooks.get(name).push(fn)
      return () => {}
    },
    inject() {},
    effect() {},
    provide(name, value) {
      services.set(name, value)
    },
    get() {
      return undefined
    },
  }
}

test('端到端：开关打开才注入，关掉立刻停', async () => {
  const home = tmpHome()
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  clearCache()
  try {
    const ctx = makeCtx()
    apply(ctx, {})
    const forge = ctx.services.get('forge')
    assert.ok(forge, 'api 未注册')

    const handler = (ctx.hooks.get('system-prompt/assemble') || []).at(-1)
    assert.ok(handler, 'assemble 钩子没注册')

    const make = () => ({
      sections: [{ name: 'harness:identity', text: 'id' }],
      contexts: [{ name: 'sandbox:policy', order: 110, text: 'p' }],
    })

    // 默认关：原样返回（同一引用）
    const initial = make()
    assert.equal(await handler(initial, {}, async () => initial), initial)

    forge.setEnabled(true)
    const onOut = await handler(make(), {}, async () => make())
    assert.ok(onOut.sections.some((s) => s.name === 'forge:prompt'), '开着应注入')

    forge.setEnabled(false)
    const input = make()
    assert.equal(await handler(input, {}, async () => input), input, '关掉后必须原样返回')

    // 打开即恢复，不用重启
    forge.setEnabled(true)
    const again = await handler(make(), {}, async () => make())
    assert.ok(again.sections.some((s) => s.name === 'forge:prompt'))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    clearCache()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
