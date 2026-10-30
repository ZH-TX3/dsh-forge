# 能力对照与实现判断

对照对象：**dsh-purge 1.1.81**（29 条代码补丁 + 11 个行为模块）
判断基准：**当前 forge 架构**（agent 预设 + 作用域 + 零源码补丁）

图例：`已实现` · `能做`（有明确 seam，未写）· `有条件`（seam 存在但有一个未验证前提）· `不能`（宿主没有公开口子）· `不该做`（属部署/产品面，不是模式面）

---

## A 提示词与人设

| # | 能力 | purge 的手段 | 宿主 seam | 判断 |
|---|---|---|---|---|
| A1 | 长人设整套替换 | 注入大段 prompt | `systemPrompt.section({complete})`，作用域内 | **已实现** |
| A2 | 必须生效的短规则 | 塞进同一段 | `systemPrompt.context()`，complete 收尾不丢 | **已实现** |
| A3 | 工作区上下文前言改写（#1/#2/#3） | 改 `agent-instructions` 常量 | 同名 scoped `section` 覆盖 | 有条件：段名需确认 |
| A4 | 身份行剥离（#25 `harness:identity`） | 改 `system-prompt` 常量 | 同名 scoped `section` 覆盖（段名已知） | **已实现** |
| A5 | 能力路由协议（skills/MCP 先读后 DIY） | `section` 注入，三变体 | `context`（complete 后仍保留） | **已实现** |
| A6 | persona 前缀别名（#38） | 改段名兼容 | 不存在此问题（v2 自命名段） | 不需要 |

## B 沙箱与审批

| # | 能力 | purge 的手段 | 宿主 seam | 判断 |
|---|---|---|---|---|
| B1 | 沙箱默认 mode（#7） | 改 `cordis.patch.yml` 默认值 | 会话策略（产品级 Permissions 已有） | 不该做 |
| B2 | approval 默认 policy（#8/#10） | 默认改成 `never` | 会话策略；且 `never` 的拒绝在监听器缝之外 | 不该做 |
| B3 | 「永远不询问」提示句（#11） | 改 prompt 常量 | `systemPrompt.context` 同名覆盖（段名 `approval:policy`） | 有条件：order 语义未验 |
| B4 | escalation 无条件授信（#13/#14/#34/#35） | 改 `approveEscalation()`，缺审批时授信 | `approval/request` 终端 answerer → `allowed-once` | **已实现** |
| B5 | sandbox confine 直通（#15） | `confine()` 返回未包裹 argv | 换 `ctx.sandbox` provider（realm 隔离） | 有条件：实例生命周期需真机验 |
| B6 | seatbelt 写封条反转（#6） | 字面 `deny`→`allow` | 同上（macOS 专属） | 工具链属 macOS（SBPL）；执行位置不可用（需 mac 主机） |
| B7 | fs 围栏拆掉（#16） | `checkedTarget()` 直通 | 换 `ctx.fs` provider（`dsh-fs-local` 替 `dsh-fs-sandbox`） | 有条件：`cwd` 是静态配置、会话 cwd 是动态的 |
| B8 | 观察策略放行（#17） | `writeIntent()` 返回 `void` | 宿主全局挂 `dsh-fs-observation-policy`，走 `fs/*` 事件闸 | **不能**（预设卸不掉宿主行；仅换 provider 后待验是否也绕过） |

## C 工具行为

| # | 能力 | purge 的手段 | 宿主 seam | 判断 |
|---|---|---|---|---|
| C1 | hooks 判决旁路（#30/#31/#64/#65） | 哨兵字符串让 `=== 'deny'` 永假 + 8 条反替换表 | `tools/pre-execute` + `prepend`，`await next()` 后只反转 deny/ask | **已实现** |
| C2 | 重复调用提醒关掉（#18） | 改宿主 reminder 常量 | `agent/pre-step` 或 `tools/pre-execute` 抑制（宿主全局） | 有条件：全局监听 vs scoped 覆盖的优先级未验 |
| C3 | 工具结果裁剪关掉（#19） | 改 pruner 常量 | `tools/post-execute` 覆盖（pruner 有 9 个挂载点） | 有条件：要保住各挂载点语义 |
| C4 | bash 超时恢复（#21） | 改配置默认 | 行 config，非模式职责 | 不该做 |
| C5 | read 上限抬高（#22） | 改 `tool-fs` 常量 | 预设内挂自己的 `dsh-tool-fs`（scoped 覆盖全局） | 能做 |
| C6 | net-scope 地域门 | 自建代理/拦截层 | 宿主无出口 seam | **不能**（且与模式无关） |

## D 会话与产物

| # | 能力 | purge 的手段 | 宿主 seam | 判断 |
|---|---|---|---|---|
| D1 | rewind 回退到某 turn | 私有 surface 写会话 | 无公开写入口（append 不接受新 type） | **不能** |
| D2 | 自动续跑 / 重试 | `agent/status` + followup | `agent/status` + `agent/request-error` + `agent.followup()` | **已实现**（续跑默认关） |
| D3 | 会话 v0 别名（#39） | 改 session-format 常量 | 宿主兼容层，非模式 | 不该做 |
| D4 | 加密资产表 | 自造加密槽 + 解包 | v2 有意用明文文件 | 不做 |

## E 部署与壳层

| # | 能力 | purge 的手段 | 判断 |
|---|---|---|---|
| E1 | desktop 壳改造（#45/#46/#82/#83/#84）、asar 拆包、shim 注入、cmd flash | 改 `desktop-shell` / 拆包 / 换 startup | 不该做（部署面） |
| E2 | 自更新 / 卸载 | 自建 update/uninstall 流程 | 不该做（`plugin_manager` 已覆盖） |
| E3 | settings 遗留 API（#42）、session-controller（#85） | 宿主兼容补丁 | 不该做 |
| E4 | 启动落定窗口（settle-policy） | 等 Fiber 装配完再决定重打/重启 | 不需要（forge 不改宿主，没有要重打的东西） |

## F UI

| # | 能力 | purge 的手段 | 判断 |
|---|---|---|---|
| F1 | 面板内编辑提示词 | Web 面板 + 自建路由 | 不做（改文件即生效，模式选择本身就是开关） |
| F2 | skill / MCP 可见性面板 | Client slot | 不做（已有独立插件 skill-mcp-gate 负责） |

---

## 统计

| 判断 | 条数 | 说明 |
|---|---|---|
| 已实现 | 3 | A1 A2 B4 C1 |
| 能做 | 1 | C5（需复制整条 fs 工具链，暂缓） |
| 有条件 | 7 | A3 B3 B5 B6 B7 C2 C3 |
| 不能 | 3 | B8 C6 D1 |
| 不该做 / 不需要 | 9 | 部署面与产品面 |

**结论：purge 的能力大头要么已在作用域内实现，要么属于部署面。**
现在只剩 C5（能复制但不想复制）和「有条件」里的 B5/B7 值得投入。

---

## 实现方式判断（逐条给方法，不给愿望）

### 已有确定方法（照着写就行）

- **A4 身份行剥离**：`section({ name: 'harness:identity', text: '' })`。同名 scoped 覆盖全局，空文本即剥离。**代价**：与 complete 段二选一（两个 complete 会抛错），所以它只在 persona 没设 complete 时有意义。
- **A5 能力协议**：`section` + `context` 各一份。段名不带自己前缀（purge 踩过：宿主 renderPrompt 会按前缀重排）。
- **C5 read 上限**：预设内挂 `dsh-tool-fs`，config 抬 `readLimit/readMaxBytes`。工具注册是 scoped 覆盖全局，宿主那份不动。
- **D2 自动续跑**：`agent/created` → `agent.ctx` 注册，监听 `turn/end`/`assistant/message`，判据「非用户取消 + 非永久错误 + 无新人类发言」，用 `agent.followup()` 唤醒。v1 `core/effects.js` 的实现可直接搬（含 280ms 延迟与按 turn 计预算）。

### 有条件 —— 每条都要先做一次定点实验，不许先写代码

| 条目 | 实验 | 判据 |
|---|---|---|
| A3 | 打印一次 standard 会话的 `assembly.sections` 名字清单 | 拿到 `agent-instructions` 的段名才能覆盖 |
| B3 | 同名 `context` 覆盖 `approval:policy`，看 order 与内容谁赢 | 覆盖成功且句子只出现一次 |
| B5 | 预设 realm 里挂 `SandboxProvider` 替身，跑一次 bash | 命令 args 里没有 bwrap/landlock 包裹 |
| B7 | 预设 realm 里挂 `dsh-fs-local`，写一个 workspace 外的文件 | 写入成功；同时确认相对路径落在**会话** cwd（这是 `cwd` 静态配置的坑） |
| C2/C3 | 同一 scope 同时挂宿主全局监听与 scoped 监听，看执行顺序 | 知道 scoped 能否压住全局，才谈得上抑制 |

**B7 是这批里唯一的硬骨头**：`dsh-fs-local` 的 `cwd` 是挂载期静态值，而会话 cwd 是运行期的。如果对不上，写出去的文件会落到错误目录 —— 那比"围栏没拆"危险得多。**验证不过就不做**，宁可留着围栏。

### 不能 —— 记录原因，别再试

- **B8 观察策略**：宿主全局挂，预设没有卸载权。
- **C6 net-scope**：宿主没有网络出口 seam。
- **D1 rewind**：会话 append 不接受插件自定义事件类型，也没有回退 API。

### 推荐顺序

1. **A4 + A5 + C5**（三条确定方法，一个下午）
2. **D2**（搬 v1 effects，配真事件断言）
3. **B7 实验**（最危险的一条，先实验后决定）
4. **B5 实验**
5. A3 / B3 / C2 / C3 按实验结果决定，未通过的直接从清单划掉
