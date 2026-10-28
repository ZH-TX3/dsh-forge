/**
 * 测试用 DSH_HOME。
 *
 * 为什么需要：`apply()` 会读 `$DSH_HOME/dsh-forge/state.json` 的总开关。
 * 单测不能依赖跑测机器上的真实开关状态 —— 那会让同一份代码在不同机器上结果不同。
 *
 * 每个用 apply() 的测试文件都应该摊一个临时 home，并根据需要显式打开开关。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * @param {{enabled?:boolean}} [opts]
 * @returns {{home:string, restore:()=>void}}
 */
export function useTempHome(opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home

  if (opts.enabled !== undefined) {
    fs.mkdirSync(path.join(home, 'dsh-forge'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'dsh-forge', 'state.json'),
      `${JSON.stringify({ enabled: !!opts.enabled }, null, 2)}\n`,
      'utf8',
    )
  }

  return {
    home,
    restore() {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      try {
        fs.rmSync(home, { recursive: true, force: true })
      } catch {
        /* 清理失败不影响结论 */
      }
    },
  }
}
