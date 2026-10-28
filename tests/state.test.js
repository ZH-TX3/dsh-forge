/**
 * 运行时总开关。
 *
 * 语义必须严格：关掉 = 四层改写 + 能力 + 效果**全部**不生效，
 * 而配置（cordis.patch.yml）不变，打开即恢复，不需要重启。
 *
 * 这里同时验证「不是纯 UI 开关」——关了以后管线真的不动数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearCache, isEnabled, readState, setEnabled, setUiVisible, statePath, writeState } from '../core/state.js'
import { resolveConfig } from '../core/config.js'
import { Journal } from '../core/journal.js'
import { Pipeline } from '../core/pipeline.js'
import { createRunner } from '../core/runner.js'
import { apply } from '../index.js'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-state-'))
}

test('没有 state.json 时默认是开', () => {
  const home = tmpHome()
  try {
    clearCache()
    const st = readState(home)
    assert.equal(st.enabled, true)
    assert.equal(st.exists, false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('关掉后读回来是关，且写入时间被记录', () => {
  const home = tmpHome()
  try {
    clearCache()
    const out = setEnabled(home, false)
    assert.equal(out.enabled, false)
    const st = readState(home)
    assert.equal(st.enabled, false)
    assert.equal(st.exists, true)
    assert.match(st.at, /^\d{4}-\d{2}-\d{2}T/)
    assert.ok(fs.existsSync(statePath(home)))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('损坏的 state.json 不会把功能锁死（按开处理）', () => {
  const home = tmpHome()
  try {
    fs.mkdirSync(path.join(home, 'dsh-forge'), { recursive: true })
    fs.writeFileSync(statePath(home), '{ 这不是 json')
    clearCache()
    assert.equal(readState(home).enabled, true)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('写入会立刻失效缓存（不用等 500ms）', () => {
  const home = tmpHome()
  try {
    clearCache()
    readState(home) // 先填缓存
    setEnabled(home, false)
    assert.equal(readState(home).enabled, false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('isEnabled 同时看配置与开关', () => {
  const home = tmpHome()
  try {
    clearCache()
    assert.equal(isEnabled(home, resolveConfig({}, {})), true)

    setEnabled(home, false)
    assert.equal(isEnabled(home, resolveConfig({}, {})), false)

    // 配置层关掉也等于不生效
    assert.equal(isEnabled(home, resolveConfig({ enabled: false }, {})), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('writeState 支持只改一处，不清掉其它字段', () => {
  const home = tmpHome()
  try {
    clearCache()
    writeState(home, { enabled: false })
    writeState(home, {})
    assert.equal(readState(home).enabled, false, '空 patch 不应把开关重置成开')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('悬浮层开关独立于功能开关', () => {
  const home = tmpHome()
  try {
    clearCache()
    assert.equal(readState(home).ui, false, '默认隐藏（插件装上不该自己冒出来）')

    // 显式隐藏也不影响功能开关
    setUiVisible(home, false)
    const st = readState(home)
    assert.equal(st.ui, false)
    assert.equal(st.enabled, true, '隐藏 UI 不应改变功能开关')

    setEnabled(home, false)
    assert.equal(readState(home).ui, false, '关功能不应改变 UI 开关')

    setUiVisible(home, true)
    assert.equal(readState(home).ui, true)
    assert.equal(readState(home).enabled, false, '显示 UI 不应打开功能')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ 管线闸 */

function makeRunner(isActive) {
  const journal = new Journal()
  const pipeline = new Pipeline({ journal })
  pipeline.register({ id: 'core:test', layer: 'L1', apply: (v) => [...v, 'CHANGED'] }, 'builtin')
  const runner = createRunner({
    pipeline,
    journal,
    forgeContext: () => ({}),
    closedLayers: () => new Set(),
    layerEnabled: () => true,
    isActive,
  })
  return runner
}

test('总开关关掉时 runObject / runMessages 原样返回', async () => {
  const off = makeRunner(() => false)
  const assembly = { sections: [{ name: 'a' }], contexts: [] }
  assert.equal(await off.runObject('assemble', assembly, {}), assembly, 'runObject 应返回同一对象')
  assert.deepEqual(await off.runMessages('pre-step', ['m'], {}), ['m'])

  const on = makeRunner(() => true)
  const changed = await on.runObject('assemble', assembly, {})
  assert.notEqual(changed, assembly, '开的时候应该被改写')
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

test('/forge 命令：默认悬浮层关，能开关两项', async () => {
  const home = tmpHome()
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  clearCache()
  try {
    let registered = null
    const ctx = {
      on: () => () => {},
      effect(fn) {
        if (typeof fn === 'function') fn()
      },
      provide() {},
      get() {
        return undefined
      },
      inject(deps, cb) {
        if (Array.isArray(deps) && deps.includes('commands')) {
          cb({
            commands: {
              register(spec) {
                registered = spec
                return () => {}
              },
            },
            effect() {},
          })
        }
      },
    }
    apply(ctx, {})

    assert.ok(registered, '/forge 命令没注册')
    assert.equal(registered.name, 'forge')
    assert.equal(typeof registered.handler, 'function')

    // 默认状态：功能开、悬浮层关
    const status = await registered.handler({ rawInput: 'status' })
    assert.equal(status.kind, 'success')
    assert.match(status.text, /功能\s+开/)
    assert.match(status.text, /悬浮层\s+隐藏/)

    // 打开悬浮层
    const onUi = await registered.handler({ rawInput: 'ui on' })
    assert.equal(onUi.kind, 'success')
    assert.equal(readState(home).ui, true)

    // 关掉功能，但 UI 保持
    const off = await registered.handler({ rawInput: 'off' })
    assert.equal(off.kind, 'success')
    assert.equal(readState(home).enabled, false)
    assert.equal(readState(home).ui, true)

    // 无参数 = status
    const bare = await registered.handler({ rawInput: '' })
    assert.equal(bare.kind, 'success')

    // 乱输 → 明确报错而不是静默
    const bad = await registered.handler({ rawInput: 'nonsense' })
    assert.equal(bad.kind, 'error')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    clearCache()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('端到端：api 关掉开关后，assemble 钩子不再改写', async () => {
  const home = tmpHome()
  try {
    clearCache()
    const ctx = makeCtx()
    process.env.DSH_HOME = home
    apply(ctx, {})
    const forge = ctx.services.get('forge')
    assert.ok(forge, 'api 未注册')
    assert.equal(forge.isActive(), true)

    const handler = (ctx.hooks.get('system-prompt/assemble') || []).at(-1)
    assert.ok(handler)

    const make = () => ({
      sections: [{ name: 'harness:identity', text: 'id' }],
      contexts: [{ name: 'sandbox:policy', order: 110, text: 'p' }],
    })

    const before = make()
    const onOut = await handler(make(), {}, async () => make())
    assert.ok(onOut.sections.some((s) => s.name === 'forge:prompt'), '开着时应注入')

    forge.setEnabled(false)
    assert.equal(forge.isActive(), false)

    const input = make()
    const offOut = await handler(input, {}, async () => input)
    assert.equal(offOut, input, '关掉后必须原样返回（同一引用）')

    // 打开即恢复，不用重启
    forge.setEnabled(true)
    const again = await handler(make(), {}, async () => make())
    assert.ok(again.sections.some((s) => s.name === 'forge:prompt'))
  } finally {
    delete process.env.DSH_HOME
    fs.rmSync(home, { recursive: true, force: true })
  }
})
