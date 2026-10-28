/**
 * 记事本 —— 每个 feature 往里记一行，排障时看最近发生了什么。
 *
 * 环形缓冲，不落盘：模式内没有「常驻状态文件」这种东西，
 * 状态只存在于会话（插件图）里。
 */
const LIMIT = 200

export class Journal {
  #entries = []

  record(entry) {
    const row = { at: new Date().toISOString(), ...entry }
    this.#entries.push(row)
    if (this.#entries.length > LIMIT) this.#entries.shift()
    return row
  }

  /** 最近 n 条，新的在前。 */
  recent(n = 20) {
    return this.#entries.slice(-n).reverse()
  }

  get size() {
    return this.#entries.length
  }

  clear() {
    this.#entries = []
  }
}
