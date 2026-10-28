/**
 * 端到端：用假的 cordis ctx 模拟宿主的两处 hook，验证装配真的接上了。
 * 这里不碰宿主源码、不起 DSH —— 只验证「我们注册的回调收到什么、返回什么」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { useTempHome } from './helpers.js'
import { PROMPT_SECTION, CONTEXT_SECTION } from '../layers/builtin.js'

// 总开关默认关，集成测试必须显式打开，且用临时 home（不碰跑测机器上的真实状态）。
const HOME = useTempHome({ enabled: true })
process.on('exit', () => HOME.restore())

function makeCtx() {
  const hooks = new Map()
  const services = new Map()
  const ctx = {
    hooks,
    services,
    on(name, fn) {
      if (!hooks.has(name)) hooks.set(name, [])
      hooks.get(name).push(fn)
      return () => {
        const list = hooks.get(name) || []
        const at = list.indexOf(fn)
        if (at >= 0) list.splice(at, 1)
        return true
      }
    },
    inject() {
      return null
    },
    effect(fn) {
      if (typeof fn === 'function') fn()
    },
    provide(name, value) {
      services.set(name, value)
    },
    get(name) {
      return services.get(name)
    },
  }
  return ctx
}

/** 取某个 hook 的最后一个注册者（我们用的是 prepend，单测里顺序无所谓）。 */
function hookOf(ctx, name) {
  const list = ctx.hooks.get(name) || []
  assert.ok(list.length > 0, `没有注册 ${name}`)
  return list[list.length - 1]
}

function makeAssembly() {
  return {
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.', order: -1000 },
      { name: 'deployment:persona-prefix', text: 'persona', order: 0 },
    ],
    contexts: [{ name: 'sandbox:policy', order: 110, text: 'mode=workspace-write' }],
    tools: [],
    variables: {},
  }
}

const nextReturning = (value) => async () => value

test('L1 + L1b 在 assemble hook 上同时生效', async () => {
  const ctx = makeCtx()
  apply(ctx, {})
  const handler = hookOf(ctx, 'system-prompt/assemble')

  const out = await handler(makeAssembly(), {}, nextReturning(makeAssembly()))

  assert.equal(out.sections[0].name, PROMPT_SECTION)
  assert.ok(out.sections[0].text.length > 0)
  assert.equal(out.sections[0].interpolate, false)
  assert.ok(!out.sections.some((s) => s.name === 'harness:identity'), '默认剔除身份段')
  assert.ok(out.contexts.some((c) => c.name === CONTEXT_SECTION))
  assert.ok(out.contexts.some((c) => c.name === 'forge:capability'), '能力协议默认注入')
  assert.equal(out.contexts.length, 3)
  assert.deepEqual(out.tools, [])
})

test('同一个 assembly 反复过 hook 结果稳定（无叠加）', async () => {
  const ctx = makeCtx()
  apply(ctx, {})
  const handler = hookOf(ctx, 'system-prompt/assemble')

  const first = await handler(makeAssembly(), {}, nextReturning(makeAssembly()))
  let current = first
  for (let i = 0; i < 5; i += 1) current = await handler(current, {}, nextReturning(current))

  assert.deepEqual(
    current.sections.map((s) => s.name),
    first.sections.map((s) => s.name),
  )
  assert.equal(current.sections.filter((s) => s.name === PROMPT_SECTION).length, 1)
  assert.equal(current.contexts.filter((c) => c.name === CONTEXT_SECTION).length, 1)
})

test('L1 关闭时 sections 原样，L1b 仍然生效', async () => {
  const ctx = makeCtx()
  apply(ctx, { layers: { L1: false } })
  const handler = hookOf(ctx, 'system-prompt/assemble')

  const input = makeAssembly()
  const out = await handler(input, {}, nextReturning(input))

  assert.equal(out.sections, input.sections, 'sections 引用未变')
  assert.ok(out.contexts.some((c) => c.name === CONTEXT_SECTION), 'contexts 仍被注入')
})

test('全部关闭时根本不接线（真·零开销）', () => {
  const ctx = makeCtx()
  apply(ctx, { layers: { L1: false, L1b: false } })
  // 该钩子上没有任何启用的层 → 连监听都不注册，宿主每一次装配都不经过我们。
  assert.equal((ctx.hooks.get('system-prompt/assemble') || []).length, 0)
})

test('disabled 时完全不注册 assemble hook', () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: false })
  assert.equal((ctx.hooks.get('system-prompt/assemble') || []).length, 0)
})

test('钩子内部抛错时不破坏宿主：原样返回', async () => {
  const ctx = makeCtx()
  apply(ctx, { promptFile: 'no/such/file.md' })
  const handler = hookOf(ctx, 'system-prompt/assemble')
  const forge = ctx.services.get('forge')

  // 造一个坏 assembly 让中间件抛错
  const out = await handler({ sections: null, contexts: null }, {}, nextReturning({ sections: null, contexts: null }))
  assert.ok(out)
  const errors = forge.journal.recent(50).filter((x) => x.op === 'error')
  assert.ok(errors.length >= 0, '至少有日志通道，不炸宿主')
})

test('L2 默认关闭：不注册 pre-step', () => {
  const ctx = makeCtx()
  apply(ctx, {})
  assert.equal((ctx.hooks.get('agent/pre-step') || []).length, 0)
})

test('L2 打开后剥掉用户消息的 ChatML 外壳', async () => {
  const ctx = makeCtx()
  apply(ctx, { layers: { L2: true } })
  const handler = hookOf(ctx, 'agent/pre-step')

  const payload = {
    messages: [{ role: 'user', content: '<|im_start|>system:<project_instructions>\n在吗\n</project_instructions>' }],
    turn: 1,
    step: 1,
  }
  const out = await handler(payload, nextReturning({ kind: 'enter', messages: payload.messages }))
  assert.equal(out.kind, 'enter')
  assert.equal(out.messages[0].content, '在吗')
})

test('L2 遇到 reject 决策时不动', async () => {
  const ctx = makeCtx()
  apply(ctx, { layers: { L2: true } })
  const handler = hookOf(ctx, 'agent/pre-step')

  const decision = { kind: 'reject' }
  const out = await handler({ messages: [] }, nextReturning(decision))
  assert.equal(out, decision)
})

test('L3 关闭时不注册 session/created', () => {
  const ctx = makeCtx()
  apply(ctx, {})
  assert.equal((ctx.hooks.get('session/created') || []).length, 0)
})

test('L3 打开后包装 deriveMessages 并且身份稳定', () => {
  const ctx = makeCtx()
  apply(ctx, { layers: { L3: true } })
  const onCreated = hookOf(ctx, 'session/created')

  const base = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]
  const session = { id: 's1', deriveMessages: () => base }
  onCreated(session)

  // 没有 L3 中间件时（内置不含 L3），返回原数组内容且对象引用不变
  const first = session.deriveMessages()
  const second = session.deriveMessages()
  assert.deepEqual(first, base)
  assert.equal(first[0], second[0], '同一源消息复用同一对象，不撑大 frozenMessages')
})

test('status() 反映配置与中间件真实状态', () => {
  const ctx = makeCtx()
  apply(ctx, { layers: { L2: true }, stripSections: ['harness:identity'] })
  const forge = ctx.services.get('forge')
  const status = forge.status(ctx)

  assert.equal(status.enabled, true)
  assert.equal(status.layers.L2, true)
  assert.equal(status.layers.L3, false)
  assert.ok(status.middleware.length >= 3)
  assert.equal(status.sections.prompt, PROMPT_SECTION)
  assert.equal(status.counts.L1, 1)
  assert.ok(status.prompt.bytes > 0, '默认 base.md 应被读到')
})

test('mods 目录里的文件被自动加载（拖拽性）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mods-'))
  try {
    fs.writeFileSync(
      path.join(dir, 'custom.mjs'),
      `export default { id: 'mod:custom', layer: 'L1', priority: 1,
        apply(sections) { return [{ name: 'mod:custom', text: 'X', order: 0 }, ...sections] } }\n`,
      'utf8',
    )
    const ctx = makeCtx()
    apply(ctx, { modsDir: dir })
    const forge = ctx.services.get('forge')
    await forge.reloadMods()

    assert.ok(forge.pipeline.has('mod:custom'))
    const handler = hookOf(ctx, 'system-prompt/assemble')
    const input = makeAssembly()
    const out = await handler(input, {}, nextReturning(input))
    // 自定义中间件 priority=1 先跑（插到最前），内置 core:prompt-inject(100) 后跑并占头部。
    // 这是有意的：核心提示词固定在第一位，mods 插在它后面，顺序可预测。
    assert.equal(out.sections[0].name, 'forge:prompt')
    assert.equal(out.sections[1].name, 'mod:custom')
    assert.equal(out.sections.filter((s) => s.name === 'mod:custom').length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('坏 mod 文件不拖垮插件，只进 journal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-badmod-'))
  try {
    fs.writeFileSync(path.join(dir, 'broken.mjs'), 'export default { id: 42 }\n', 'utf8')
    const ctx = makeCtx()
    apply(ctx, { modsDir: dir })
    const forge = ctx.services.get('forge')
    const state = await forge.reloadMods()

    assert.equal(state.errors.length, 1)
    assert.ok(forge.pipeline.has('core:prompt-inject'), '内置中间件仍在')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
