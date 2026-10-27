/**
 * 纯文本工具。全部无副作用、无依赖，便于单测。
 *
 * 这里刻意不做的事：
 *   · 不做 `{{}}` 转义 —— 我们注册的 section 一律 `interpolate:false`，插值不生效。
 *   · 不做 ChatML 剥壳 —— 那是内容层策略，属于中间件，不属于核心。
 */

/** 统一成 LF，返回 [normalized, hadCrlf]。 */
export function toLf(text) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  const hadCrlf = s.includes('\r\n')
  return [hadCrlf ? s.replace(/\r\n/g, '\n') : s, hadCrlf]
}

/** 还原 CRLF。 */
export function fromLf(text, hadCrlf) {
  return hadCrlf ? String(text ?? '').replace(/\n/g, '\r\n') : String(text ?? '')
}

/** 取一段文本的首尾指纹，用于判断"这段是不是已经在了"。 */
export function fingerprint(text, head = 80, tail = 96) {
  const s = String(text ?? '').trim()
  if (!s) return { head: '', tail: '', contains: () => true }
  const h = s.slice(0, head)
  const t = tail > 0 ? s.slice(-tail) : ''
  return {
    head: h,
    tail: t,
    contains(haystack) {
      const body = String(haystack ?? '')
      if (!body.includes(h)) return false
      return t === '' ? true : body.includes(t)
    },
  }
}

/** 段/消息数组里有没有任何一项包含整段文本。 */
export function anyContains(items, text) {
  const fp = fingerprint(text)
  if (!String(text ?? '').trim()) return true
  return (Array.isArray(items) ? items : []).some((item) => {
    const body = typeof item === 'string' ? item : item?.text
    return typeof body === 'string' && fp.contains(body)
  })
}

/** 取消息的可见文本（兼容 string content 与 block 数组）。 */
export function messageText(message) {
  if (typeof message === 'string') return message
  const content = message?.content ?? message?.text
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (typeof block === 'string' ? block : block?.type === 'text' ? String(block.text ?? '') : ''))
    .join('')
}

/** 只替换文本块，保留其余 block（图片、工具调用等）原样。 */
export function replaceMessageText(message, nextText) {
  if (typeof message === 'string') return nextText
  const content = message?.content
  if (typeof content === 'string') return { ...message, content: nextText }
  if (!Array.isArray(content)) return { ...message, content: nextText }
  let replaced = false
  const blocks = content.map((block) => {
    if (replaced) return block
    const isText = typeof block === 'string' || block?.type === 'text'
    if (!isText) return block
    replaced = true
    return typeof block === 'string'
      ? nextText
      : { ...block, text: nextText }
  })
  return { ...message, content: blocks }
}

/** 估算字节数，用于日志与状态页。 */
export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

/** 截断到 n 字符，用于日志。 */
export function clip(text, n = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}
