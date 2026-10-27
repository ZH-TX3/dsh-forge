/**
 * 变更日志。两层数据：
 *   items  —— 最近一次改动/报错/跳过的明细（环形缓冲，默认 200 条）
 *   stats  —— 各 hook 的调用计数与最近时间，供 L5 状态页
 *
 * 只记录「改了什么」，不记提示词正文（正文可能很长，且属于敏感内容）。
 */

const CAP = 200

export class Journal {
  #items = []
  #cap
  stats = {
    assemble: 0,
    'pre-step': 0,
    history: 0,
    lastAt: null,
    lastHook: null,
  }

  constructor(cap = CAP) {
    this.#cap = Math.max(20, Number(cap) || CAP)
  }

  /** @param {{layer?:string,id?:string,op:string,note?:string,bytes?:number}} entry */
  record(entry) {
    this.#items.push({ at: new Date().toISOString(), ...entry })
    if (this.#items.length > this.#cap) this.#items.splice(0, this.#items.length - this.#cap)
  }

  /** hook 被调用一次。 */
  touch(hook) {
    if (hook in this.stats) this.stats[hook] += 1
    this.stats.lastAt = new Date().toISOString()
    this.stats.lastHook = hook
  }

  recent(n = 40) {
    const size = Math.max(1, Math.min(Number(n) || 40, this.#items.length || 1))
    return this.#items.slice(-size)
  }

  /** 只取异常条目，状态页优先展示。 */
  errors(n = 10) {
    return this.#items.filter((x) => x.op === 'error').slice(-n)
  }

  clear() {
    this.#items = []
    for (const key of Object.keys(this.stats)) {
      this.stats[key] = key === 'lastAt' || key === 'lastHook' ? null : 0
    }
  }
}
