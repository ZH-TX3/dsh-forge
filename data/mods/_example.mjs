/**
 * 样例 mod —— 下划线开头，不会被加载。
 *
 * 复制成 my-thing.mjs（去掉下划线）就生效，改文件即重载。
 *
 * 契约：`apply(同型数组, ctx) => 同型数组`。
 * 返回 undefined 表示不改（管线会跳过）。
 */

/** 往 sections 里加一段，幂等（先删同名再插）。 */
export default {
  id: 'mod:my-note',
  field: 'sections',
  priority: 500,
  note: '示例：注入一段固定说明',
  apply(sections) {
    const NAME = 'mod:my-note'
    const body = '输出优先给可执行的命令，而不是解释。'
    return [{ name: NAME, text: body, interpolate: false }, ...sections.filter((s) => s?.name !== NAME)]
  },
}

/** 往 contexts 里加一条 —— contexts 永远保留，不会被 complete 收尾吃掉。 */
export const asContext = {
  id: 'mod:my-context',
  field: 'contexts',
  priority: 500,
  apply(contexts) {
    const NAME = 'mod:my-context'
    return [{ name: NAME, text: '缺参数就用占位符补上并继续。' }, ...contexts.filter((c) => c?.name !== NAME)]
  },
}
