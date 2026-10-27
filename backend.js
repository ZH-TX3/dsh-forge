/**
 * L5 后端：只读状态 API。
 *
 * 全部动作都是「读」或「重载」，没有任何写配置/写文件的入口 ——
 * 面板看到的东西必须和管线实际行为一致，不能让 UI 变成第二份真相。
 *
 *   GET  /dsh-forge/api?op=state            状态快照（默认）
 *   GET  /dsh-forge/api?op=journal&n=40     最近变更明细
 *   POST /dsh-forge/api?op=reload           清提示词缓存 + 重载 mods
 *   POST /dsh-forge/api?op=clear            清空日志
 *
 * 只接受回环来源。webServer 一般只绑 127.0.0.1，这里再加一道。
 */

const API_PREFIX = '/dsh-forge/api'

function isLoopback(req) {
  const remote = req?.socket?.remoteAddress ?? ''
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === ''
}

function send(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * @param {object} ctx cordis ctx
 * @param {{status:Function, journal:object, reloadAll:Function}} forge
 */
export function installBackend(ctx, forge) {
  try {
    ctx.inject(['webServer'], (wctx) => {
      const handler = async (req, res) => {
        if (!isLoopback(req)) return send(res, 403, { ok: false, error: 'loopback only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const op = url.searchParams.get('op') || 'state'

        try {
          if (op === 'state') return send(res, 200, { ok: true, ...forge.status() })

          if (op === 'journal') {
            const n = Number(url.searchParams.get('n')) || 40
            return send(res, 200, { ok: true, stats: { ...forge.journal.stats }, items: forge.journal.recent(n) })
          }

          if (req.method !== 'POST') return send(res, 405, { ok: false, error: `${op} requires POST` })

          if (op === 'reload') {
            const mods = await forge.reloadAll()
            return send(res, 200, { ok: true, mods })
          }

          if (op === 'clear') {
            forge.journal.clear()
            return send(res, 200, { ok: true })
          }

          return send(res, 404, { ok: false, error: `unknown op: ${op}` })
        } catch (error) {
          return send(res, 500, { ok: false, error: String(error?.message || error) })
        }
      }

      const dispose = wctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
      if (typeof wctx.effect === 'function') wctx.effect(() => dispose, 'dsh-forge: status api')
    })
  } catch {
    /* 没有 webServer（headless / tui）：状态页不可用，插件其它部分照常工作 */
  }
}

export { API_PREFIX }
