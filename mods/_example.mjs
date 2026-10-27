/**
 * 样例中间件 —— 下划线开头，不会被加载。
 *
 * 复制成 my-thing.mjs（去掉下划线）就生效。
 * 下面的四个例子各自演示一层的写法，按需删掉。
 */

/* ---------------------------------------------------------------- L1 */

/** 在 system prompt 里加一段，并保证不重复。 */
export const addSection = {
  id: 'mod:add-section',
  layer: 'L1',
  priority: 500,
  describe: '示例：注入一段固定说明',
  apply(sections) {
    const NAME = 'mod:my-note'
    const body = '输出时优先给可执行的命令，而不是解释。'
    // 先删同名段再插，天然幂等。
    return [{ name: NAME, text: body, order: 1200, interpolate: false }, ...sections.filter((s) => s?.name !== NAME)]
  },
}

/** 改某个已有段 —— 但只改一次，靠标记防叠加。 */
export const patchSection = {
  id: 'mod:patch-section',
  layer: 'L1',
  priority: 600,
  describe: '示例：改官方某段文案（带幂等标记）',
  apply(sections) {
    return sections.map((section) => {
      if (section?.name !== 'harness:identity') return section
      if (String(section.text || '').includes('[mod]')) return section
      return { ...section, text: `${section.text} [mod]` }
    })
  },
}

/* ---------------------------------------------------------------- L1b */

/** 往 runtime context 里加一条。complete:true 预设下这条也不会丢。 */
export const addContext = {
  id: 'mod:add-context',
  layer: 'L1b',
  describe: '示例：追加一条运行时事实',
  apply(contexts) {
    const NAME = 'mod:my-fact'
    return [...contexts.filter((c) => c?.name !== NAME), { name: NAME, order: 500, text: '工作目录已启用严格输出模式。' }]
  },
}

/* ---------------------------------------------------------------- L2 */

/** 改写用户本轮输入。只在 layers.L2 = true 时才会跑到。 */
export const normalizeUserText = {
  id: 'mod:normalize-user',
  layer: 'L2',
  describe: '示例：把 TODO 占位符替换成明确提示',
  apply(messages) {
    return messages.map((message) => {
      if (message?.role && message.role !== 'user') return message
      const content = message?.content
      if (typeof content !== 'string' || !content.includes('<TODO>')) return message
      return { ...message, content: content.replaceAll('<TODO>', '（未指定的目标）') }
    })
  },
}

/* ---------------------------------------------------------------- L3 */

/** 折叠历史里的某类消息。必须同步。默认 L3 关闭，不会生效。 */
export const foldHistory = {
  id: 'mod:fold-history',
  layer: 'L3',
  describe: '示例：把过长的工具结果压成一行',
  apply(messages) {
    const LIMIT = 4000
    return messages.map((message) => {
      const content = message?.content
      if (typeof content !== 'string' || content.length <= LIMIT) return message
      return { ...message, content: `${content.slice(0, LIMIT)}\n…（已截断）` }
    })
  },
}

export default [addSection, patchSection, addContext, normalizeUserText, foldHistory]
