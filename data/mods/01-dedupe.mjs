/**
 * mod:dedupe-sections —— 按文本给 sections 去重。
 *
 * 为什么要它：宿主与本插件的段来自不同来源（全局、scoped、mod），
 * 同名覆盖之外还可能出现「不同名字、同一段话」的重复。
 * 重复段落每次装配都要付 token，且会稀释注意力。
 *
 * 语义：
 *   - 文本完全相同（trim 后）的段只留第一个（order 靠前的那个，因为输入已排序）。
 *   - 空段保留：空的 section 渲染时不出内容，删掉它反而可能改变宿主对段序的假设。
 *   - 幂等：跑两次结果一样。
 *
 * priority 900 = 排在大多数改写之后跑，去的是「改写完仍然重复」的那些。
 */
export default {
  id: 'mod:dedupe-sections',
  field: 'sections',
  priority: 900,
  note: '按文本去重 sections（保留首个，空段不动）',

  apply(sections) {
    if (!Array.isArray(sections)) return sections
    const seen = new Set()
    const out = []
    for (const section of sections) {
      const text = String(section?.text ?? '')
      if (text.trim() === '') {
        out.push(section)
        continue
      }
      const key = text.trim()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(section)
    }
    return out
  },
}
