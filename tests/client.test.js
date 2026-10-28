/**
 * client.js 冒烟测试。
 *
 * 它只做一件事：在输入框那一行（`.uV2eYG_row`）里渲染一个 iOS 风格开关。
 * 这里用极简 React + 假 fetch 把它渲染成对象树来断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const CLIENT = path.join(process.cwd(), 'client.js')

function makeReact(hookBag = {}) {
  const cursors = new Map()
  const stack = []
  const react = {
    createElement(type, props, ...children) {
      const kids = children.flat().filter((c) => c !== null && c !== undefined && c !== false)
      if (typeof type === 'function') {
        const name = type.name || 'Anonymous'
        stack.push(name)
        cursors.set(name, 0)
        try {
          return type({ ...(props || {}), children: kids })
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
      return [bag && i < bag.length ? bag[i] : initial, () => {}]
    },
    useEffect() {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    Component: class {},
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

function loadClient({ hookBag = {}, fetchImpl = async () => ({ ok: true, json: async () => ({}) }) } = {}) {
  const code = fs.readFileSync(CLIENT, 'utf8')
  let captured = null
  const run = new Function('window', 'fetch', 'setInterval', 'clearInterval', code)
  run(
    { __ModuleLoader__: { load: (spec) => (captured = spec) } },
    fetchImpl,
    () => 0,
    () => {},
  )
  assert.ok(captured, 'client.js 没有调用 __ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-forge')

  const react = makeReact(hookBag)
  const mod = captured.factory((name) => (name === 'react' ? react : {}))
  return { mod, react }
}

function pickComponent(mod) {
  let registered = null
  mod.apply({
    slots: {
      inject(name, cb) {
        assert.equal(name, 'conversation.input.left', '必须挂在输入框那一行的插槽')
        cb()
      },
      register(spec, Component) {
        registered = { spec, Component }
      },
    },
  })
  assert.ok(registered, '没有注册开关组件')
  return registered
}

function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.type) out.push(node)
  for (const child of node.children || []) walk(child, out)
  return out
}

function findSwitch(tree) {
  return walk(tree).find((n) => n.props?.role === 'switch')
}

/* ------------------------------------------------------------------ 用例 */

test('工厂可求值，注册到 conversation.input.left', () => {
  const { mod } = loadClient()
  assert.deepEqual(mod.inject, ['slots'])
  const { spec, Component } = pickComponent(mod)
  assert.equal(spec.id, 'dsh-forge-switch')
  assert.equal(spec.order, 10)
  assert.equal(typeof Component, 'function')
})

test('还没读到状态时渲染 null（不闪错状态）', () => {
  const { mod, react } = loadClient({ hookBag: { ForgeSwitch: [null, false] } })
  const { Component } = pickComponent(mod)
  assert.equal(react.__render(Component), null)
})

test('开启态：aria-checked=true、iOS 绿、旋钮在右', () => {
  const { mod, react } = loadClient({ hookBag: { ForgeSwitch: [true, false] } })
  const { Component } = pickComponent(mod)
  const tree = react.__render(Component)
  const sw = findSwitch(tree)

  assert.ok(sw, '没渲染出 role=switch 的元素')
  assert.equal(sw.props['aria-checked'], 'true')
  assert.equal(sw.props.style.background, '#34c759', 'iOS 开关绿')

  const knob = sw.children[0]
  assert.equal(knob.props.style.left, 16, '开启时旋钮在右')
  assert.equal(knob.props.style.width, 14)
  assert.equal(sw.props.style.width, 32)
  assert.equal(sw.props.style.height, 18)
  assert.equal(sw.props.style.borderRadius, 9)
})

test('关闭态：aria-checked=false、系统灰、旋钮在左', () => {
  const { mod, react } = loadClient({ hookBag: { ForgeSwitch: [false, false] } })
  const { Component } = pickComponent(mod)
  const sw = findSwitch(react.__render(Component))

  assert.equal(sw.props['aria-checked'], 'false')
  assert.equal(sw.props.style.background, 'rgba(120,120,128,.32)')
  assert.equal(sw.children[0].props.style.left, 2, '关闭时旋钮在左')
})

test('同一行里带 "forge" 小标签，便于辨认', () => {
  const { mod, react } = loadClient({ hookBag: { ForgeSwitch: [true, false] } })
  const { Component } = pickComponent(mod)
  const text = JSON.stringify(react.__render(Component))
  assert.match(text, /forge/)
})

test('点击发 POST /dsh-forge/api?op=toggle', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, json: async () => ({ ok: true, enabled: false }) }
  }
  const { mod, react } = loadClient({ hookBag: { ForgeSwitch: [true, false] }, fetchImpl })
  const { Component } = pickComponent(mod)
  const sw = findSwitch(react.__render(Component))

  await sw.props.onClick()

  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /op=toggle/)
  assert.equal(calls[0].init.method, 'POST')
})

test('样式里没有 undefined / NaN', () => {
  const { mod, react } = loadClient({ hookBag: { ForgeSwitch: [true, false] } })
  const { Component } = pickComponent(mod)
  for (const node of walk(react.__render(Component))) {
    const style = node.props?.style
    if (!style) continue
    for (const [key, value] of Object.entries(style)) {
      assert.notEqual(value, undefined, `样式 ${key} 是 undefined`)
      assert.ok(!(typeof value === 'number' && Number.isNaN(value)), `样式 ${key} 是 NaN`)
    }
  }
})
