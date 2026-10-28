/**
 * client.js 冒烟测试。
 *
 * client.js 是浏览器侧代码（`window.__ModuleLoader__.load`），普通 import 跑不了。
 * 这里用一个极简 React（会把函数组件就地展开）把它渲染成普通对象树，验证：
 *   · 工厂函数能求值（没有顶层错误）
 *   · 面板与 chip 都能渲染成元素树
 *   · 面板宽度被 300px 卡住，样式里没有 undefined / NaN
 *   · 空状态不崩
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const CLIENT = path.join(process.cwd(), 'client.js')

/* ------------------------------------------------------------------ 极简 React */

/**
 * @param {Record<string, any[]>} hookBag 每个组件的 useState 初值序列（按调用序）
 */
function makeReact(hookBag = {}) {
  const cursors = new Map()
  const stack = []

  const react = {
    createElement(type, props, ...children) {
      const kids = children.flat().filter((c) => c !== null && c !== undefined && c !== false)
      if (typeof type === 'function') {
        // 就地展开函数组件
        const name = type.name || 'Anonymous'
        stack.push(name)
        cursors.set(name, 0)
        try {
          const rendered = type({ ...(props || {}), children: kids })
          return rendered
        } finally {
          stack.pop()
        }
      }
      return { type, props: props || {}, children: kids }
    },

    useState(initial) {
      const name = stack[stack.length - 1] || 'Anonymous'
      const i = cursors.get(name) ?? 0
      cursors.set(name, i + 1)
      const bag = hookBag[name]
      const value = bag && i < bag.length ? bag[i] : initial
      return [value, () => {}]
    },

    useEffect() {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef(initial) {
      return { current: initial }
    },
    Component: class {},

    /** 直接把根组件当函数调用时，也要让它有名字（否则 hook 取不到值）。 */
    __render(Component, props = {}) {
      const name = Component.name || 'Anonymous'
      stack.push(name)
      cursors.set(name, 0)
      try {
        return Component(props)
      } finally {
        stack.pop()
      }
    },
  }
  return react
}

/* ------------------------------------------------------------------ 加载 */

function loadClient(hookBag = {}) {
  const code = fs.readFileSync(CLIENT, 'utf8')
  let captured = null
  const run = new Function('window', code)
  run({ __ModuleLoader__: { load: (spec) => (captured = spec) } })
  assert.ok(captured, 'client.js 没有调用 __ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-forge')

  const react = makeReact(hookBag)
  const mod = captured.factory((name) => (name === 'react' ? react : {}))
  return { mod, react }
}

function pickComponent(mod) {
  let Component = null
  mod.apply({
    slots: {
      inject(name, cb) {
        assert.equal(name, 'conversation.input.dock')
        cb()
      },
      register(_spec, C) {
        Component = C
      },
    },
  })
  assert.equal(typeof Component, 'function', '没有注册插槽组件')
  return Component
}

/** 收集整棵元素树。 */
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.type) out.push(node)
  for (const child of node.children || []) walk(child, out)
  return out
}

function textOf(node) {
  if (!node) return ''
  if (typeof node === 'string') return node
  return (node.children || []).map(textOf).join(' ')
}

const STATE = {
  enabled: true,
  ui: true,
  layers: { L1: true, L1b: true, L2: false, L3: false },
  layerMeta: [
    { id: 'L1', title: 'system prompt' },
    { id: 'L1b', title: 'runtime context' },
    { id: 'L2', title: 'user message' },
    { id: 'L3', title: 'assistant 历史' },
  ],
  counts: { L1: 1, L1b: 2, L2: 1, L3: 0 },
  prompt: { bytes: 1337 },
  context: { bytes: 391 },
  mods: { files: [], errors: [] },
  host: { sandboxMode: 'danger-full-access', approvalPolicy: 'ask' },
}

const JOURNAL = {
  items: [
    { layer: 'L1', id: 'core:prompt-inject', op: 'rewrite', note: 'x' },
    { layer: 'L1b', id: 'core:context-inject', op: 'install', note: 'y' },
    { layer: 'core', id: 'hook:assemble', op: 'error', note: 'boom' },
  ],
}

/* ------------------------------------------------------------------ 用例 */

test('工厂可求值，apply 注册到 conversation.input.dock', () => {
  const { mod } = loadClient()
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')
  pickComponent(mod) // 内部断言 id 与 name
})

test('收起的 chip 能渲染，且显示启用的层名', () => {
  const { mod, react } = loadClient({ ForgeDock: [false, STATE, null] })
  const tree = react.__render(pickComponent(mod))
  const text = textOf(tree)
  assert.match(text, /forge L1 L1b/)
})

test('展开后渲染面板：层、字节数、journal 都在', () => {
  const { mod, react } = loadClient({ ForgeDock: [true, STATE, JOURNAL] })
  const tree = react.__render(pickComponent(mod))
  const nodes = walk(tree)
  const text = textOf(tree)

  assert.ok(nodes.length > 15, `元素太少（${nodes.length}），面板可能没渲染`)
  assert.match(text, /L1b/, '缺层行')
  assert.match(text, /1337B/, '缺 prompt 字节数')
  assert.match(text, /391B/, '缺 ctx 字节数')
  assert.match(text, /core:prompt-inject/, '缺 journal 条目')
  assert.match(text, /danger-full-access/, '缺 sandbox 状态')
})

test('面板宽度卡在 300px，且样式无 undefined / NaN', () => {
  const { mod, react } = loadClient({ ForgeDock: [true, STATE, JOURNAL] })
  const nodes = walk(react.__render(pickComponent(mod)))

  const widths = nodes.map((n) => n.props?.style?.maxWidth).filter((v) => v !== undefined)
  assert.ok(widths.includes(300), `没有 300px 上限，实测 ${JSON.stringify(widths)}`)

  for (const node of nodes) {
    const style = node.props?.style
    if (!style) continue
    for (const [key, value] of Object.entries(style)) {
      assert.notEqual(value, undefined, `样式 ${key} 是 undefined`)
      assert.ok(!(typeof value === 'number' && Number.isNaN(value)), `样式 ${key} 是 NaN`)
    }
  }
})

test('state 为 null 时显示「读取状态中」而不是崩', () => {
  const { mod, react } = loadClient({ ForgeDock: [true, null, null] })
  const text = textOf(react.__render(pickComponent(mod)))
  assert.match(text, /读取状态中/)
})

test('浮动层：position:fixed，脱离文档流', () => {
  const { mod, react } = loadClient({ ForgeDock: [false, STATE, null] })
  const nodes = walk(react.__render(pickComponent(mod)))
  const fixed = nodes.filter((n) => n.props?.style?.position === "fixed")
  assert.equal(fixed.length, 1, '应该恰好有一个固定定位的容器')
  const style = fixed[0].props.style
  assert.equal(style.right, 16)
  assert.equal(style.bottom, 16)
  assert.equal(style.position, "fixed")
  // 不能再依赖 order 挤在流里
  assert.equal(style.order, undefined)
})

test('state.ui === false 时什么都不渲染（功能层不受影响）', () => {
  const hidden = { ...STATE, ui: false }
  const { mod, react } = loadClient({ ForgeDock: [false, hidden, null] })
  const tree = react.__render(pickComponent(mod))
  assert.equal(tree, null)
})

test('mods 有错误时把文件名显示出来', () => {
  const broken = { ...STATE, mods: { files: [], errors: [{ file: 'bad.mjs', error: 'boom' }] } }
  const { mod, react } = loadClient({ ForgeDock: [true, broken, null] })
  const text = textOf(react.__render(pickComponent(mod)))
  assert.match(text, /mods 加载失败/)
  assert.match(text, /bad\.mjs/)
})
