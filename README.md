# dsh-forge — 锻造模式

一个 **DSH agent 预设**，不是一个全局改机插件。

选「锻造模式」的会话才有 forge 的能力；不选，插件图里连一行都没有。
这不是靠开关兜住的，是 Cordis 预设作用域的结构必然。

```
L1 模式层   preset preset-forge（显示名：锻造模式）  ← 能力清单，一行一个 feature
L2 装配层   system-prompt                          ← 送给模型的文本
L3 工具层   tools                                  ← 调用的判定与结果
L4 会话层   agent / session                        ← 时序与失败处理
D  数据层   data/（人设、规则、mods）               ← 改文件即生效
L0 宿主层   @deepseek-ai/*                          ← 一行不改（唯一例外见 host-seam）
```

## 装

```bash
# 开发态：本地目录，改文件即生效
plugin_manager install_bundle target=D:/ds/dsh-plugins/dsh-forge

# 发布态：GitHub 快照，锁 commit，可复现
dsh plugin install github:ZH-TX3/dsh-forge#<sha>
```

`cordis.patch.yml` 里没有绝对路径，三种装法解析到同一份代码：

| 装法 | 写法 | 改文件是否即生效 |
|---|---|---|
| 本地目录 | `link:D:/ds/dsh-plugins/dsh-forge` | 是（开发用这个） |
| GitHub 快照 | `github:ZH-TX3/dsh-forge#<sha>` | 否，锁 commit |
| release 包 | `…/releases/download/v0.2.0/local-dsh-forge-0.2.0.tgz` | 否 |

做法是 10 个能力模块的 spec 写成 **包名 + 包内路径**（`@local/dsh-forge/features/persona/index.js`）：
预设子行不走 Loader 的相对解析（baseUrl 是 profile 根，不是本目录），但裸包名会走 profile 的
`node_modules`，所以三种装法都能解析。

### 装完怎么算装上了

1. `npm run verify` → 全绿（当前 52 条）。
2. 会话创建处能选到「锻造模式」。
3. 展开这个预设，10 行都是 **ACTIVE**，没有 `never started` / `waiting for`。
4. 新开会话选它，问一句「你现在的系统提示词第一行是什么」—— 应该是
   `data/prompts/base.md` 的第一行（当前是「# 操作者提示词」）。

任何一条不成立，看下面的「排查」。

### 卸

```bash
plugin_manager remove_bundle target=@local/dsh-forge
```

profile 里不留任何 forge 行。已经进入过历史会话的注入内容撤不回（那是宿主语义，
见「已知边界」）。

## 用

| 想改什么 | 改哪 | 生效 |
|---|---|---|
| 长人设（整套替换默认 system prompt） | `data/prompts/base.md` | 立刻 |
| 必须生效的短规则 | `data/rules/*.md`（文件名前缀即顺序） | 立刻 |
| 中间件（改装配的 sections / contexts / tools） | `data/mods/*.mjs` | 立刻 |
| 能力路由协议 | `data/capability-protocol.md` | 立刻 |
| 授信放行哪些工具 | `cordis.patch.yml` → `forge-bypass-approval.allow`（`['bash*']`，空数组 = 全放） | 重启 |
| 反转哪些 hooks 判决 | `forge-hooks-bypass.invert`（默认 `deny` + `ask`）与 `tools` 白名单 | 重启 |
| 重试预算 / 终态码 | `forge-request-retry.max` / `.permanent` | 重启 |
| 自动续跑 | `forge-auto-continue.enabled`（默认 **false**） | 重启 |
| L0 写前闸 | `forge-host-seam.enabled`（默认 **false**，开了全局生效） | 重启 |
| 挂哪些能力 | `config.plugins` | 重启 |

### 两个旁路的前提

- **授信旁路**要求会话 approval policy 是默认的 `ask`。宿主把 `never` 的拒绝放在
  监听器缝之外，切到 `never` 时本功能静默失效 —— 那是宿主语义，不是 bug。
- **hooks 判决旁路**是「先让下游跑完，再换终局判决」，不是「跳过 hooks」。
  hook 子进程照跑、日志照写，被换掉的只有结论。

### 三条宿主语义（本仓库的承重墙）

1. `systemPrompt.section/context` 是 **scoped 注册**，`system-prompt/assemble` 是
   **scope-filtered 派发** → 人设只进本模式的装配。
2. `complete: true` 让本段成为唯一 prompt section，**该语义也只在本 scope 内成立**。
3. `contexts` 永远保留 —— 这就是为什么硬规则放 `data/rules/`，长人设放 persona。

## mods

`data/mods/*.mjs`，下划线开头不加载。契约一句话：

```js
export default {
  id: 'mod:my-thing',      // 唯一 id，同 id 覆盖
  field: 'sections',       // sections | contexts | tools | assembly
  priority: 500,           // 同 field 内小者先跑
  apply(value, ctx) {      // (同型数组, ctx) => 同型数组
    return value           // 返回 undefined 表示不改
  },
}
```

- **改文件即重载**：按 `文件名 + mtime + size` 做指纹，指纹进 import URL（Node 的 ESM
  缓存按 URL 走，只换 map 的 key 拿不到新模块）。节流 `rescanMs`，默认 1s。
- **出错只记日志**：一个 mod 抛异常，装配照常返回，其余 mod 继续。
- `assembly` 字段拿整个装配对象，改它是最后手段（要自己保住别的插件贡献的字段）。

## 验

两个脚本分工不同，都要绿：

```bash
npm run verify          # 52 条：机制对不对（真宿主、真事件、负向对照）
npm run mods            # 5 条：你现在装的这套 mod 真的在跑、改/删即时生效
npm run prompt          # 把「锻造模式」与「部署态基线」的系统提示词都渲染出来做 diff
```

`prompt` 是唯一回答「选了模式，模型看到的东西到底变了什么」的工具：
它读 `cordis.patch.yml`（唯一真相源）+ `dsh --dump-config` 的真实人设，
用宿主自己的 `renderPrompt` 渲染两份，再给差异。改 `data/prompts/base.md`
之后跑一次，改动立刻可见。`--raw` 不省略。

`verify` 用**真宿主代码**跑真装配：同一个宿主两个 scope，一个选模式、一个不选，
断言两边不同，且不选的那边干净。**每条负向对照都先证明自己会失败** —— 这是纪律，
不是修辞（假绿踩过两次）。

| 组 | 证什么 |
|---|---|
| V-A / V-F | 人设与硬规则进装配；`complete` 吃掉 sections 后 contexts 仍在 |
| V-B | 负向对照：不选模式的 scope 里一个 forge 段都没有 |
| V-C | 宿主零侵入 + 清单一致性（每个 `features/` 目录都有行，spec 都指向真文件） |
| V-D | 数据层改文件即生效（mtime 缓存真的会失效） |
| V-E | 一个 feature 抛错，其余照常挂 |
| V-G | 中间件：生效、热重载、mod 抛错隔离、对照 scope 干净 |
| V-H | 授信判决（纯函数三态） |
| V-I | hooks 判决反转（真瀑布；I1 先证明宿主 deny 生效） |
| V-J | 身份行同名覆盖；能力协议在 complete 之后仍存活 |
| V-K | 兜底重试（预算、终态码、abort） |
| V-L | 自动续跑判决链（含外部取消五因） |
| V-M / V-N / V-P | 形状纪律：inject 合法、挂载不 waiting、`apply` 无返回值 |
| V-Q | 文件缓存指纹（同长度改写也刷新；读不到返回 null） |
| V-R | 每个 feature 都有「能力/落点/失败模式/断言」四行的 README |
| V-O | L0 seam（真瀑布；O1 先证明闸存在） |

## 排查

| 症状 | 原因 | 怎么办 |
|---|---|---|
| 某行 `never started` | spec 没解析到模块 | 子行不走相对路径；用 `@local/dsh-forge/features/<id>/index.js`。V-C3 会先报 |
| 某行 `waiting for X, Y` | `inject` 声明了不存在的服务 | Cordis 的 inject 只有「字符串数组」和「name → config map」；写成 `{required, optional}` 会把两个键当服务名。V-M 会报 |
| 装完抛 `Invalid effect` | `apply` 返回了非函数值 | 在 root ctx 会抛，scope 里被静默忽略 —— 别依赖。`apply` 只调 `mount`，不返回。V-P 会报 |
| 选模式后没看到人设 | 文件路径错，或 `complete` 与 `identity-strip` 互斥 | `data/prompts/base.md` 必须非空；`identity-strip` 在 `complete: true` 下是空操作 |
| 改了 `data/` 没反应 | 改的是 `features/` 或 `cordis.patch.yml` | 前者要重启；后两者都要重启。只有 `data/**` 是立刻生效 |

## 目录

```
cordis.patch.yml        模式声明（只 insert 预设行，不 override 宿主任一行）
data/prompts/base.md    L1 长人设（complete 段）
data/rules/*.md         L1b 硬规则（contexts，complete 也吃不掉）
data/capability-protocol.md  能力路由协议（contexts）
data/mods/*.mjs         中间件（下划线开头不加载）
features/<id>/          能力模块：index.js + README（能力 / 落点 / 失败模式 / 断言编号）
lib/                    纯函数与 I/O（files 缓存、journal）
scripts/verify.mjs      真宿主断言（52）
scripts/mods-check.mjs  真目录 mods 管线（5）
MODE.md                 架构设计与阶段计划
CAPABILITIES.md         与 dsh-purge 的逐项能力对照与实现判断
```

## 能力模块

| feature | 层 | 机制 | 默认 |
|---|---|---|---|
| `persona` | L2 | `section(complete)` 整套替换 | 开 |
| `rules` | L2 | `context()`，complete 收尾也不丢 | 开 |
| `capability-protocol` | L2 | `context()`，能力路由协议 | 开 |
| `identity-strip` | L2 | 同名 scoped 覆盖 `harness:identity`（`complete` 下是空操作） | 开 |
| `middleware` | L2 | `system-prompt/assemble` 瀑布 + mods 热插拔 | 开 |
| `hooks-bypass` | L3 | `tools/pre-execute` prepend 后反转终局判决 | 开 |
| `bypass-approval` | L3 | `approval/request` 终端 answerer | 开（全放） |
| `request-retry` | L4 | `agent/request-error` 兜底，宿主放弃时才补 | 开 |
| `auto-continue` | L4 | `agent/status` idle → 280ms → `followup` | **关**（有竞态） |
| `host-seam` | L0 | `fs/*-intent` prepend claim，等于观测策略不存在 | **关**（全局生效） |

## 加一个能力

1. `features/<id>/index.js`：

```js
export const name = 'forge-<id>'
export const inject = ['systemPrompt']        // 数组，或 name → config 的 map
export function mount(ctx, config = {}) { … return api }
export function apply(ctx, config = {}) { mount(ctx, config) }
export default { name, inject, apply }
```

2. `cordis.patch.yml` 的 `plugins:` 加一行（spec 用包名 + 包内路径）。
3. `features/<id>/README.md` 写四行：能力 / 落点 / 失败模式 / 断言编号。
4. `node scripts/verify.mjs` —— V-C4 会告诉你「加了目录忘了加行」。

铁律：

- **`apply` 不返回任何值**，只委托 `mount`。要句柄的测试/脚本调 `mount()`。
- **`apply` 内自兜底**：加载期不抛。预设里任一行激活失败会连累整个预设。
- **模块之间不 import**：共享逻辑只走 `lib/`（纯函数，无 ctx）。
- **不监听别人的 scope**，所有注册都带自己作用域。

## 环境

- 开发与验证环境：**Windows + Git Bash（MSYS 路径）**，Node v24，宿主为安装态 DSH。
  不是 macOS —— 涉及 seatbelt / bwrap / landlock 的条目在本机**不可验证**，
  仓库里标「不可在本机验证」而不是「待做」。
- **验收全部是文本**：`verify` / `mods` / `prompt` 都只输出可读文本，会话日志是
  zstd 多帧、按帧头切开解码后读。没有任何一步依赖看屏幕或截图 —— 这不只是习惯，
  是设计约束：能写进文件的才算被看见。
- `.git` 是指向父仓库的 submodule 指针（父仓库在 `D:\ds\dsh-plugins`）。
- 路径写法混用两种方言：Node 侧用 `D:/a/b`，Git Bash 侧用 `/d/a/b`。

## 已知边界

- 模式是编译期装配：`mods/` 的热插拔只在 `features/middleware` 内部，不承诺跨 feature。
- 会话历史不可撤：注入过的内容写进了历史，换模式也撤不回（宿主语义）。
- `host-seam` 一旦打开就是全局生效 —— `fs/write-intent` / `fs/edit-intent` 没有作用域派发。
- 没做的能力（fs 围栏拆除、rewind、net-scope）及原因见 `CAPABILITIES.md`。
