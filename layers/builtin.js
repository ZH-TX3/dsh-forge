/**
 * 内置中间件。
 *
 * 注意：这里没有任何"特殊通道"。内置功能和 mods/ 里的用户中间件
 * 走的是同一条 Pipeline.run()，同样会被 layers 开关、middleware 覆盖影响。
 * 唯一的差别是出错时的默认行为（内置抛错，用户中间件只记日志）。
 *
 * 每个中间件都必须是纯函数：给定同样的输入返回同样的输出，不读写磁盘、不改全局。
 */

/** 本插件注入段的名字。改这个名字等于换一份注入通道。 */
export const PROMPT_SECTION = 'forge:prompt'
export const CONTEXT_SECTION = 'forge:context'

/**
 * 按 order 稳定排序。
 *
 * 宿主的 assemble() 在 waterfall **之前**排过一次序；我们在之后追加/改写，
 * 所以得自己排回来 —— 否则 forge:capability(998) 会排在 forge:context(999) 后面。
 */
function sortByOrder(list) {
  return [...list].sort((a, b) => {
    const ao = Number.isFinite(a?.order) ? a.order : 0
    const bo = Number.isFinite(b?.order) ? b.order : 0
    return ao - bo
  })
}

/* ------------------------------------------------------------------ L1 */

/**
 * 注入提示词正文，并剔除配置里点名的段。
 *
 * 幂等靠「段名」而不是字符串比对：每次都先删同名段再插，
 * 所以重复执行结果恒定，不像 purge 的 STRONG_* 自匹配替换会每次叠加。
 */
export const promptInject = {
  id: 'core:prompt-inject',
  layer: 'L1',
  priority: 100,
  describe: '注入提示词正文到 sections 首位，并按配置剔除指定段',
  apply(sections, ctx) {
    const list = Array.isArray(sections) ? sections : []
    const strip = Array.isArray(ctx.stripSections) ? ctx.stripSections : []
    const body = String(ctx.promptText ?? '').trim()

    // 1. 剔除点名段（默认只剔 harness:identity）
    const kept = strip.length ? list.filter((s) => !strip.includes(s?.name)) : list.slice()

    // 2. 无论正文是否为空，都先清掉上一次的自己（热重载 / 多注册时不残留）
    const others = kept.filter((s) => s?.name !== PROMPT_SECTION)
    if (!body) return others

    // 3. 置顶插入
    return [{ name: PROMPT_SECTION, text: body, order: ctx.promptOrder, interpolate: false }, ...others]
  },
}

/* ------------------------------------------------------------------ L1b */

/**
 * 在 runtime context 里放一段短而硬的规则。
 *
 * 这是本项目最重要的一段代码：`complete:true` 的预设会丢掉所有 sections，
 * 但永远丢掉 contexts（见 dsh-system-prompt assemble() 的返回分支）。
 * 所以"必须永远生效"的规则放这里，长人设放 L1。
 */
export const contextInject = {
  id: 'core:context-inject',
  layer: 'L1b',
  priority: 100,
  describe: '注入永不丢失的 runtime context 段',
  apply(contexts, ctx) {
    const list = Array.isArray(contexts) ? contexts : []
    const body = String(ctx.contextText ?? '').trim()
    const others = list.filter((c) => c?.name !== CONTEXT_SECTION)
    if (!body) return sortByOrder(others)
    // context 的 order 决定它渲染成第几条附加消息，取 999 排在官方策略后面。
    return sortByOrder([...others, { name: CONTEXT_SECTION, order: 999, text: body }])
  },
}

/**
 * 覆盖官方 context 文案（默认不启用 —— 只在 config.contextOverrides 非空时生效）。
 * 用于「宿主说的和我实际给的权限不一致」时把话术拉正，而不是去改宿主源码。
 */
export const contextOverride = {
  id: 'core:context-override',
  layer: 'L1b',
  priority: 200,
  describe: '按配置改写指定 context 段的文案',
  apply(contexts, ctx) {
    const map = ctx.contextOverrides && typeof ctx.contextOverrides === 'object' ? ctx.contextOverrides : null
    if (!map) return contexts
    const list = Array.isArray(contexts) ? contexts : []
    return sortByOrder(
      list.map((item) => {
        const next = item && typeof item.name === 'string' ? map[item.name] : undefined
        return typeof next === 'string' ? { ...item, text: next } : item
      }),
    )
  },
}

/**
 * 能力协议 —— 教模型"先读目录，再按任务选"。
 *
 * 放 L1b 而不是 L1：这是每轮都必须生效的纪律，而 L1b 在 complete:true 预设下也不会丢。
 * 刻意写短：它挂在每一步的运行时上下文里，长了就是在烧 token。
 */
const CAPABILITY_TEXT = `能力选用（按任务匹配，不是每次都调满，也不是永远不调）：
1. 先看 \`<available_skills>\` / 技能目录 / 已挂的 MCP 与工具清单，知道有什么再动手。
2. 按**当前这个任务**选需要的那几个，不必全用、也不必都不用。
3. 命中的 Skill 用 \`skill\` 工具加载后按它执行；命中的 MCP/CLI 按 schema 调用。
4. 目录里确实没有匹配项，才自己用 shell 拼，并说明缺了什么。
5. 派子代理时在同一条指令里要求它也先读目录再选。`

export const capabilityProtocol = {
  id: 'core:capability-protocol',
  layer: 'L1b',
  priority: 300,
  describe: '教模型先读 skill / MCP 目录，再按任务选用',
  apply(contexts, ctx) {
    if (ctx?.config?.capabilityProtocol === false) return contexts
    const list = Array.isArray(contexts) ? contexts : []
    return sortByOrder([
      ...list.filter((c) => c?.name !== 'forge:capability'),
      { name: 'forge:capability', order: 998, text: CAPABILITY_TEXT },
    ])
  },
}

/* ------------------------------------------------------------------ L2 */

/**
 * 剥掉粘贴内容里的 ChatML / project_instructions 外壳。
 *
 * 只在 L2 打开时生效。作用对象是"用户本轮发来的文本"，
 * 不碰历史、不碰磁盘 —— 与 L4 的事后改写是两回事。
 */
export const userStripEnvelope = {
  id: 'core:user-strip-envelope',
  layer: 'L2',
  priority: 100,
  describe: '剥掉用户输入里的 ChatML / project_instructions 外层标签',
  apply(messages) {
    const list = Array.isArray(messages) ? messages : []
    return list.map((message) => {
      if (!isUserAuthored(message)) return message
      const content = message.content

      if (typeof content === 'string') {
        const cleaned = stripEnvelope(content)
        return cleaned === content ? message : { ...message, content: cleaned }
      }
      if (!Array.isArray(content)) return message

      // 逐 block 处理：图片、工具调用等非文本 block 原样保留。
      let changed = false
      const blocks = content.map((block) => {
        if (typeof block === 'string') {
          const cleaned = stripEnvelope(block)
          if (cleaned === block) return block
          changed = true
          return cleaned
        }
        if (block?.type !== 'text' || typeof block.text !== 'string') return block
        const cleaned = stripEnvelope(block.text)
        if (cleaned === block.text) return block
        changed = true
        return { ...block, text: cleaned }
      })
      return changed ? { ...message, content: blocks } : message
    })
  },
}

function stripEnvelope(text) {
  return String(text)
    .replace(/<\/?project_instructions>/gi, '')
    .replace(/<\|im_start\|>\s*system:\s*/gi, '')
    .replace(/<\|im_end\|>/gi, '')
    .trim()
}

/** 只认"用户自己发的"消息：不碰助手消息、工具结果、宿主合成消息。 */
function isUserAuthored(message) {
  if (!message || typeof message !== 'object') return false
  if (message.role !== undefined && message.role !== 'user') return false
  const kind = message.source?.kind
  return kind === undefined || kind === 'user' || kind === 'dsh-forge'
}


/* ------------------------------------------------------------------ 全量导出 */

export const builtinMiddlewares = Object.freeze([
  promptInject,
  contextInject,
  capabilityProtocol,
  contextOverride,
  userStripEnvelope,
])
