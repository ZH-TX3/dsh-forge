/**
 * 中间件自动发现 —— 「拖拽性」的实现。
 *
 * 把文件丢进 mods/ 就生效，改文件下次请求就重载（按 mtime），删文件就卸载。
 * 不需要改 index.js、不需要改配置、不需要重启宿主。
 *
 * 文件形状（.mjs / .js 均可）：
 *
 *     export default { id, layer, priority?, apply }
 *     // 或一次导出多个
 *     export default [{ ... }, { ... }]
 *
 * 约束：
 *   · 单个文件出错不影响其它文件，也不影响宿主启动。
 *   · id 重复则后加载的覆盖先加载的（内置在前，mods 在后 → mods 能盖内置）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const EXT = new Set(['.mjs', '.js'])

/** 列出目录下的候选文件（排序固定，保证加载顺序可复现）。 */
export function listModFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((ent) => ent.isFile() && EXT.has(path.extname(ent.name)))
      // 下划线开头的文件是样例/草稿，不加载。
      .filter((ent) => !ent.name.startsWith('_'))
      .map((ent) => path.join(dir, ent.name))
      .sort()
  } catch {
    return []
  }
}

/**
 * 加载目录下全部中间件。
 * @returns {Promise<{specs: object[], errors: {file:string,error:string}[]}>}
 */
export async function loadMods(dir) {
  const specs = []
  const errors = []
  for (const file of listModFiles(dir)) {
    try {
      // 带 mtime 查询串，绕过 ESM 模块缓存 → 改文件即时生效。
      const st = fs.statSync(file)
      const url = `${pathToFileURL(file).href}?m=${st.mtimeMs}`
      const mod = await import(url)
      const exported = mod?.default ?? mod?.middlewares
      const list = Array.isArray(exported) ? exported : exported ? [exported] : []
      if (list.length === 0) {
        errors.push({ file, error: '没有 default 导出中间件' })
        continue
      }
      for (const spec of list) specs.push(spec)
    } catch (error) {
      errors.push({ file, error: String(error?.message || error) })
    }
  }
  return { specs, errors }
}

/** 目录是否存在且有内容，供状态页显示。 */
export function modDirStatus(dir) {
  const files = listModFiles(dir)
  return { dir, exists: fs.existsSync(dir), files: files.map((f) => path.basename(f)) }
}
