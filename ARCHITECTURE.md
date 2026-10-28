# dsh-forge 架构

> 状态：**v0.2 — 架构已确认，P0–P4 已实现并通过自测**
> 目标宿主：本机 DSH `0.2.0-rc.2`（aiBase = `~/.dsh/profiles/node_modules/@deepseek-ai`，202 个包）
> 代码：`D:\ds\plugins\dsh-forge`（2859 行，含 56 个测试与文档）
> 本文是架构说明；安装与扩展用法见 `README.md`。

---

## 0. 为什么重做：purge 混乱的三个根因

| # | 根因 | 证据 |
|---|---|---|
| 1 | **维度错位** | 82 条补丁按**目标文件**组织（`agent-loop`:7、`preset-minimal`:5、`escalation`:5…），而不是按「改哪份数据 × 哪个时机」。同一层的逻辑散落在十几个文件键上，无法判断某条补丁到底在改哪份数据。 |
| 2 | **层缺失** | 只做了 L1 的 `sections`，**完全漏掉 `contexts`**（`approval:policy` / `sandbox:policy` 在这里），也漏掉 L3（assistant 历史）。缺的部分用源码补丁硬顶：#5/#11/#12/#34 改审批话术、#87/#88 兜底全文。 |
| 3 | **三重实现** | 同一个效果在 YAML config、源码补丁、运行时钩子各写一遍。最典型：`includeHarnessIdentity` 在 `cordis.patch.yml` 里配了 `false`，同时 #25 又改源码默认值——两条路径争同一件事。 |

结论：**重建分类轴，一层一件事，一个效果只有一处实现。**

---

## 1. 分类轴：改哪份数据 × 在哪个时间点

```
                     请求前（pre-request）               事后（post-hoc）      模型层
              ┌──────────────────────────────┐
   提示词侧   │ L1  system prompt                      │
              │ L1b runtime context  ← purge 缺失      │
              │ L2  user message                       │
              │ L3  assistant 历史                     │
              ├──────────────────────────────┤
   存储侧     │                                        │ L4 落盘会话文件
              ├──────────────────────────────┤
   表现侧     │                                        │ L5 UI 渲染
              ├──────────────────────────────┤
   权重侧     │                                        │        L6 权重
              └──────────────────────────────┘

   ══════════ 基座（不是层）══════════
   L0  宿主策略：沙箱模式 / 审批策略 / 工具上限 / 插件开关
```

### 1.1 六层定义

| # | 改什么 | 时机 | 稳态性 | 副作用 | 本项目态度 |
|---|---|---|---|---|---|
| L1 | system prompt（`assembly.sections`） | 请求前 | 中（`complete:true` 预设会盖掉） | 无 | **主战场** |
| L1b | runtime context（`assembly.contexts`） | 请求前 | **高（`complete` 盖不掉）** | 无 | **主战场** |
| L2 | user message（本轮输入） | 请求前 | 高 | 无 | 规则化改写 |
| L3 | assistant 历史（派生给模型的消息） | 请求前 | 高 | 破坏前缀缓存（改动历史即改前缀） | 慎用，默认关 |
| L4 | 落盘会话文件（`session.jsonl.zstd`） | 事后 | 100% | 污染上下文、不可自动回滚 | **仅修复工装，默认关** |
| L5 | UI 渲染 | 显示时 | 100% | **不解决任何问题** | 纯展示，只读 |
| L6 | 权重（abliteration / heretic） | 模型层 | 高 | 能力下降 | **不实现**，只留适配器契约 |

### 1.2 为什么 L1b 必须单独成层

purge 把 `approval:policy` / `sandbox:policy` 当成提示词文本去打源码补丁（#5/#11/#12/#34）。
实测 0.2.0-rc.2 中它们是 **context section**，走 `assembly.contexts`：

```js
// dsh-user-approval/lib/index.js
scope.systemPrompt.context({ name: "approval:policy", order: 115,
  text: (context) => effective(agent) === "never" ? NEVER_SENTENCE : ASK_SENTENCE })
// dsh-sandbox-policy/lib/index.js
scope.systemPrompt.context({ name: "sandbox:policy", order: 110, text: ... })
```

关键差异（`dsh-system-prompt/lib/index.js:355-365`）：

```js
const transformed = await this.ctx.waterfall(..., "system-prompt/assemble", assembly, context, () => assembly);
if (completeSection === void 0 && !runtimeContextSuppressed) return transformed;
return { ...transformed,
  sections: completeSection === void 0 ? transformed.sections : [completeSection],  // ← 只有 sections 被盖
  contexts: runtimeContextSuppressed ? [] : transformed.contexts };                // ← contexts 永远保留
```

**`complete:true` 会丢掉我们所有 sections，但永远动不了 contexts。**
所以 L1b 不只是"多一层"，它是**唯一在 minimal / persona-complete 预设下也稳的注入面**。

---

## 2. 目标宿主的真实钩子点（已实测）

### 2.1 请求装配主链路

```js
// dsh-agent-loop/lib/index.js:907  AgentLoop.preStep()
const assembly  = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
//                 └─ SystemPrompt.assemble() → waterfall "system-prompt/assemble"  ★L1/L1b 钩子
const sections  = renderContextSections(assembly);          // contexts → Message[]
const context   = this.runtimeContext.project(joinContextSections(sections), sections);
const decision  = await this.dispatch.waterfall("agent/pre-step",
                    { messages: claimed, turn, step, signal },                    // ★L2 钩子
                    () => ({ kind: "enter", messages: [...claimed, context] }));
return { ...decision, assembly };
```

```js
// dsh-agent-loop/lib/index.js:1262
const boundaryMessages = session.deriveMessages();   // ★L3 钩子（返回深冻结 Message[]）
```

### 2.2 各层钩子点与可用 API

| 层 | 钩子点 | 官方 API | 是否改宿主源码 |
|---|---|---|---|
| L0 | `cordis.patch.yml` 的 `config` 段 | `sandboxPolicy.mode`、`approval.policy`、`systemPrompt.includeHarnessIdentity/personaPrefix/personaSuffix` | **否** |
| L1 | `ctx.on("system-prompt/assemble")` + `systemPrompt.section({...})` | `section()` 返回 disposer；`text` 可为 `(context)=>string` | 否 |
| L1b | 同上，改 `assembly.contexts` | 同上（`systemPrompt.context()`） | 否 |
| L2 | `ctx.on("agent/pre-step", ..., {global, prepend})` | 返回 `{kind:"enter", messages}`；`{kind:"reject"}` | 否 |
| L3 | 包装 `session.deriveMessages()` | 返回新数组、替换 Message 对象（原件深冻结，不可 mutate） | 否 |
| L4 | 直接读写 `~/.dsh/sessions/<cwd>/<id>/session.jsonl.zstd` | 无官方 API（需 zstd 解压→编辑→重压） | 否（但断链） |
| L5 | `ctx.slots.inject('conversation.input.dock', ...)` 等 client 插槽 | `@deepseek-ai/dsh-client-ui-*` | 否 |
| L6 | — | — | — |

### 2.3 官方排序命名空间（不要再用 -100000）

```js
SECTION_ORDERS = { HARNESS_IDENTITY: -1000, DEPLOYMENT_PERSONA_PREFIX: 0, PLAN_POLICY: 500,
  … TOOL_BASH: 1000, … Mcp_SERVERS: 3100, WEB_SURFACE: 10100, DEPLOYMENT_PERSONA_SUFFIX: 10200 }
CONTEXT_ORDERS = { SANDBOX_POLICY: 110, APPROVAL_POLICY: 115, SUBAGENT_DELEGATION: 120 }
```

purge 用 `order: -100000` 强行置顶，是逃逸命名空间的 hack。新架构的取位策略见 D2。

---

## 3. 模块结构（实际实现）

```
dsh-forge/
├── index.js                 装配：读配置 → 建管线 → 注册内置 → 载入 mods → 挂 3 处 hook
├── cordis.patch.yml         只写 insert + config，零源码补丁
├── package.json
├── client.js                L5：只读状态 chip / 面板（不改任何数据）
├── backend.js               L5 后端：GET /dsh-forge/api?op=state|journal
├── scripts/forge.mjs        离线工装 CLI：cap / prompt / effect / advice / patch / update / session
├── scripts/preview.mjs      预览：走真实管线 + 宿主自己的 renderPrompt 渲染
│
├── core/                    核心（稳定面，约 750 行）
│   ├── hooks.js             ★ LAYERS + HOOKS 两张数据表（数据改写的耦合面）
│   ├── effects.js           ★ EFFECTS 第三张表（行为注入）
│   ├── advice.js            L0 建议项（宿主可配的、不需要打补丁的）
│   ├── state.js             运行时总开关（$DSH_HOME/dsh-forge/state.json）
│   ├── runner.js            通用执行器：钩子形态 → 跑哪些层
│   ├── pipeline.js          中间件注册表 + 顺序 + 开关 + 异步/同步两种 run
│   ├── config.js            配置解析（默认 < cordis config < DSH_FORGE_* 环境变量）
│   ├── loader.js            mods/ 自动发现（拖一个文件进来就生效）
│   ├── source.js            提示词正文读取（mtime 缓存，改文件即时生效）
│   ├── capabilities.js      L0 能力表（统一参数）+ 按成本分级的前置闸
│   ├── patch.js             源码补丁引擎（六道闸）
│   ├── l4.js                L4 会话工装（zstd，离线）
│   ├── update.js            自更新（绑 GitHub + 强制 sha256）
│   ├── host.js              L0 只读快照
│   ├── journal.js           变更日志 + 调用计数
│   └── text.js              纯文本工具
│
├── layers/
│   └── builtin.js           内置中间件（与 mods 走同一条管线，无后门）
│
├── patches/catalog.js       源码补丁目录（纯数据）
│
├── mods/                    ★ 扩展点：拖文件进来就是一个新功能
│   ├── README.md            契约与铁律
│   └── _example.mjs         四个层的样例（下划线开头 → 不加载）
│
├── prompts/
│   ├── base.md              L1 长人设（会被 complete:true 预设丢掉）
│   └── context.md           L1b 硬规则（永不丢失）
│
└── tests/                   56 个测试：pipeline / layers / config / 端到端
```

### 3.1 不耦合是怎么保证的

不是靠纪律，是靠**两张数据表 + 一个通用执行器**：

```
core/hooks.js
  LAYERS  ← 改哪份数据：{ id, hook, field, defaultOn, sync, title }
  HOOKS   ← 宿主在哪一刻给入口：{ event, mode, install }

core/runner.js
  把 mode 翻译成「跑哪些层的中间件」，不认识任何具体层名

index.js
  for (const hook of HOOKS) if (live) hook.install(...)   ← 全部装配逻辑就这几行
```

关键性质：

| 想做的事 | 要改哪里 | 要改几行代码 |
|---|---|---|
| 加一个中间件 | `mods/xxx.mjs` | **0**（不改核心，不用重启） |
| 加一层（如 L4 = 工具清单） | `core/hooks.js` 的 `LAYERS` 加一行 | **0 行代码逻辑** —— 加的是数据 |
| 接一个新钩子（宿主新发事件） | `core/hooks.js` 的 `HOOKS` 加一行 | 一个 `install()`，其余全通用 |
| 换 UI 展示的层 | 不用改，`status.layerMeta` 自动带上 | **0** |
| 删掉所有内置中间件 | 插件照常启动，只是什么都不做 | — |

有三处曾经是硬编码的，现已全部数据化：

| 原来 | 现在 |
|---|---|
| `index.js` 里 `if (L1) ...` / `if (L2) ...` 四段分支 | 一个 `for` 循环遍历 `HOOKS` |
| `config.js` 里 `for (const id of ['L1','L1b','L2','L3'])` | 遍历 `LAYER_IDS`，默认值取 `LAYERS[id].defaultOn` |
| `client.js` 里 `const LAYER_ORDER = [...]` | 读 `state.layerMeta` |

### 3.2 两种扩展模式的取舍

`LAYERS` / `HOOKS` 是 **frozen** 的：运行时改不了。这是有意的。

- 加中间件 → 完全运行时（拖文件即生效），这是日常扩展路径。
- 加层 / 加钩子 → 改一行数据 + 重启，因为「层」是架构决策，不该在运行中漂移。
  如果允许运行时加层，`closedLayers` 的语义、UI 的展示、测试的断言都会变得不可预测。

换句话说：**内容可热插拔，结构要显式。** 这条线划在 `core/hooks.js`。

### 3.3 与 purge 的结构对照

| purge | dsh-forge | 说明 |
|---|---|---|
| `lib/core.js`（7984 行，82 补丁 + 引擎 + 多宿主发现 + asar 拆包） | **整块删除** | 不碰宿主源码，这些机制不再需要 |
| `lib/identity.js`（987 行，三层混杂） | `layers/builtin.js`（约 230 行） | 只保留纯数据变换，没有装配逻辑 |
| `lib/index.js`（2596 行） | `index.js`（约 260 行） | 只做装配 |
| `lib/table-read.js` + `asset-table.js` 加密槽（解出 21194 字符） | `prompts/*.md` 明文 | 见 D4 |
| `lib/net-scope.js`（673 行，独立子系统） | L2 的一条中间件（按需放进 `mods/`） | 不再是独立子系统 |
| `lib/rewind.js`（645 行，L4 伪装成 L3） | L3 中间件（live 改写、磁盘不动） | 见 D5 |
| `lib/redteam/*`（约 1.5 万行） | **拆成独立插件** `dsh-forge-drill` | 见 D7 |
| `lib/update.js`（1120 行，无签名自更新） | 删除 | 见 D6 |
| `client.js`（8736 行，UI + 业务逻辑混杂） | `client.js`（约 290 行，只读） | 见 D7 |
| 合计约 **2.8 万行** | **2859 行**（其中实现约 1400 行、测试 600 行、文档 850 行） | 同样覆盖 L1/L1b/L2 |

---

## 4. 每层契约

| 层 | 输入 | 输出 | 幂等 | 失效模式 | 可逆 |
|---|---|---|---|---|---|
| L0 | 宿主 config | 只读快照 + 建议 | — | config 被 UI 覆写 | 天然（纯配置） |
| L1 | `assembly.sections` | 新 sections | 是（按段名替换，不叠加） | `complete:true` 预设 → 全部失效 | 卸插件即恢复 |
| L1b | `assembly.contexts` | 新 contexts | 是 | `runtimeContextSuppressed` → contexts 全空 | 卸插件即恢复 |
| L2 | `pre-step` 的 `messages` | 新 messages | 是（按规则 id 标记） | 上游 reject 先于我们 | 卸插件即恢复 |
| L3 | `deriveMessages()` 返回值 | 新数组 | 是 | Message 深冻结，只能替换不能改 | 卸插件即恢复 |
| L4 | 磁盘 `.jsonl.zstd` | 改写后的文件 | 需显式 | 压缩格式变更 / 会话正在跑 | ⚠️ 需自带 .bak |
| L5 | `/api/state` | 输入框行内的 iOS 开关（`conversation.input.left`） | — | 插槽改名 | 卸插件即恢复 |

**硬约束**：
1. 任何层都**不得**写宿主 `@deepseek-ai/*` 目录。违反即视为架构事故。
2. 任何层都**不得**改 `process.env`（purge 删了 `DSH_PERMISSION_MODE`，这是不可接受的隐式副作用）。
3. L1/L1b/L2/L3 必须是**纯函数式 transform**：`(input, context) => output`，无副作用、可单测。

---

## 5. purge 82 条补丁 → 层归属

| 归属 | purge 补丁 | 新架构做法 |
|---|---|---|
| **L1** sections | #1 #2 #3 #4 #26 #29 #33 #36 #37 #43 #70 #71 #73 #76 | 正文写进 `prompts/base.md`，由 `core:prompt-inject` 按段名替换 |
| **L1b** contexts | #5 #11 #12 #34 | `core:context-inject` 常驻硬规则；`core:context-override` 按 name 改写官方 context 文案 |
| **L0** config | #7 #8 #10 | `cordis.patch.yml` 里写 `mode` / `policy` / `includeHarnessIdentity` |
| **L0** 危险（默认关） | #6 #9 #13 #14 #15 #16 #17 #35 | 独立 `l0-danger.js`，显式开启，日志留痕 |
| **L1** 降级策略 | #40 #87 #88 | 见 D2：不再和 complete 逻辑搏斗，改由 L1b 承载必生效内容 |
| **L2** | #30 #31 #64 #65（hooks deny） | 在 `pre-step` 决策上处理，不碰宿主 hooks 包 |
| **L3 / L4** | #56 #58 #75 #77（rewind 系列） | 重写为 L3 live 改写（包装 `deriveMessages`） |
| **删除** | #45 #46 #82 #83 #84（桌面更新/崩溃静默） | 不属于任何层；静默宿主崩溃是反功能 |
| **删除** | #42 #47–#55 #57 #59–#63 #66–#69 #72 #74 #78 #80 #85 #86 | 版本兼容 / 工具话术 / 内部修补，新架构不需要 |

> 结论：**82 条 → 约 20 条真正需要的东西**，其余是实现方式本身制造的复杂度。

---

## 6. 决策记录（已确认）

| # | 决策 | 结论 | 实现落点 |
|---|---|---|---|
| D1 | 危险模块 | **改成 L0 统一能力表**，默认全关，按成本分闸 | `l0.capabilities.*`，`core/capabilities.js` |
| D2 | L1 撞 `complete:true` 预设 | 采纳三级降级；**永不**改宿主源码 | `L1` + `L1b` 双通道（见下） |
| D4 | 提示词存储 | **明文** `prompts/*.md` | `core/source.js` |
| D5 | L3 与 L4 边界 | L3 = 包装 `deriveMessages`（磁盘不动）；L4 不做 | `index.js` 中的 L3 包装 |
| D6 | 自更新 | **做，但必须钉 sha256**，未钉住只允许 check | `core/update.js` |
| D7 | 演练台 | **合理拆分 + 可扩展**，作为独立插件再接入 | 见 D7 细则 |

### D1 的实现：统一能力表，而不是一堆布尔

原先我写的是 `l0.danger.{enabled, autoApprove, unrestrictedEscalation}` ——
三个平铺开关，看不出每个动作的代价，也说不清哪些能运行时切、哪些会动本机文件。

改成 **能力表**（`core/capabilities.js`），每项强制声明三件事：

```js
{
  cost: 'native' | 'env' | 'filesystem' | 'source-patch',  // 代价
  default: false,                                           // 默认值
  apply(env) / revert(env),                                 // 做与 undo
}
```

|l 成本等级 → 前置闸：

| cost | 谁能执行 | 额外要求 |
|---|---|---|
| `native` | 宿主运行时 | 无。走官方 waterfall，审计对完整落盘 |
| `env` | 宿主运行时 | 无。进程级，disposer 可还原 |
| `filesystem` | **仅 CLI** | `--destructive` 显式确认；自动备份 + `cap revert` |
| `source-patch` | **仅 CLI** | `l0.sourcePatch.enabled` + 版本白名单 + 六道闸 |

关键点：**运行时只自动应用 native / env。** filesystem 与 source-patch 永不自动执行。
这是「不静默」的具体实现 —— 启动时不替你动本机文件、不改宿主源码。

`auto-approve` 仍然走官方 `approval/request` waterfall，不是打源码：

```js
ctx.on('approval/request', () => 'allowed-once', { global: true, prepend: true })
```

好处：`approval/asked` / `approval/decided` 这对审计事件依然完整落盘，
可审计性没被破坏（purge 的 #9 是把整条审批链删掉，连审计一起没了）。

### D1b 源码补丁：把「能力」和「怎么安全地做」分开

purge 有 82 条逐字字符串补丁，直接写盘：没有版本锁定、没有语法校验、没有 dry-run、
没有哈希留痕。宿主一升级就 `pattern_not_found` 或半替换成语法错，唯一退路是碰运气的 `.bak`。

**能力本身有价值，问题出在流程。** 所以拆成两层：

```
core/capabilities.js   声明"要不要"（cost: source-patch + patches: [id]）
patches/catalog.js     声明"改哪里"（纯数据：file / hostVersions / find / replace / marker）
core/patch.js          负责"怎么安全地改"（六道闸）
```

六道闸（`core/patch.js`）：

| # | 闸 | 挡住什么 |
|---|---|---|
| 1 | `l0.sourcePatch.enabled` | 默认关，避免"装了就生效" |
| 2 | `hostVersions` 白名单 | 宿主升级后误打 |
| 3 | `find` 唯一命中（0 或 >1 都拒） | 模糊替换改错位置 |
| 4 | dry-run 出 diff | 没看过就按下 |
| 5 | 写前 sha256 + `.forge.bak`（只建一次） | 无法追溯 / 备份被覆盖 |
| 6 | 写后 `node --check`，失败**自动回滚** | 半替换导致宿主起不来 |

第 6 条是 purge 完全没有的，也是它最容易把宿主搞坏的地方。
`node scripts/forge.mjs patch list` 会对着当前宿主逐个验证 find 串是否还唯一命中 ——
升级后先跑它，不要盲打。

### D1c 自更新：钉哈希是硬条件

purge 的 update 从 codeload 拉 zip，先 `rm -rf lib` 再覆盖，无哈希无签名，失败即半升级。
本实现改成：

```
ref → commit sha（内容寻址） → 按 sha 下载（不按 branch）
   → sha256 与配置比对 → 不一致中止
   → 解压到临时目录 → 备份现有插件 → 整体替换 → 失败回滚
```

**`update.sha256` 为空时 apply 直接拒绝，只允许 check。** 这条不可绕过：
自更新是供应链面，便利性排在正确性后面。

另一个实测坑：GitHub 对**无凭据访问私有仓库返回 404 而不是 403**，
看起来和"仓库不存在"一模一样。所以 token 是必需项，不是可选项：
`update.token` > `GITHUB_TOKEN` > `GH_TOKEN` > 本机 `gh auth token`。

### D1d L4：改成离线工装，而不是运行时能力

原方案里 L4 被我整个否掉了。正确的做法不是"不做"，而是**换执行位置**：

- 运行时改落盘历史 = 污染上下文 + 破坏前缀缓存 + 不可自动回滚
- 离线命令改同一个文件 = 可预览、可备份、可复现、可还原

Node 24 自带 `zlib.zstdCompressSync/zstdDecompressSync`，所以零依赖。

**实测踩到的坑（差点毁掉一个真会话）**：DSH 的 `session.jsonl.zstd` 是**多帧拼接**的
（追加写，一帧一段）。本机一个 212KB 的文件含 2 帧：

```
offset   0  →  194 字节（1 条 session 事件）
offset 179  →  剩下全部（900 条事件）
```

而 `zstdDecompressSync()` 和 `createZstdDecompress()` **都只解第一帧**，
不报错、不提示。天真实现会读到 1 条事件，然后写回去 → 整个会话被覆盖成 1 条。

所以读路径必须自己按帧头（`28 B5 2F FD`）切段逐帧解压，任一帧失败就整体报错中止，
**绝不退化成"只解第一帧"**。写路径输出**单帧**——任何解码器至少能读第一帧，单帧最安全。

每次写盘强制：结构复核 → 备份 → 写 → **回读验证（行数 + type 字段）**，失败自动回滚。

### D2 的实现：为什么 L1b 比 L1 更重要

实测 `dsh-system-prompt/lib/index.js` 的 assemble 返回分支：

```js
return { ...transformed,
  sections: completeSection === void 0 ? transformed.sections : [completeSection],  // ← 被盖
  contexts: runtimeContextSuppressed ? [] : transformed.contexts };                // ← 不盖
```

所以采用**双通道**，按「是否必须永远生效」分工：

| 通道 | 内容 | complete:true 时 |
|---|---|---|
| L1 `prompts/base.md` | 长人设（角色、风格、交付纪律） | 可能被丢 |
| L1b `prompts/context.md` | 极短硬规则（不铺垫、缺参用占位符、直接执行） | **一定在** |

这就是 D2 的「三级降级」在工程上的等价物：不再去和宿主的 complete 逻辑搏斗，
而是把「必须生效」的东西搬到它管不到的地方。少一层机制，多一层确定性。

### D7 的拆分方式

演练台（原 `lib/redteam/*`，约 1.5 万行）与「改提示词」是正交的两件事，
必须分开，但**接口要对齐以便后续接入**：

```
dsh-forge           只负责 L1/L1b/L2/L3 的数据改写 + 中间件管线
      ↑ 公开 export：pipeline 实例、中间件契约、journal
dsh-forge-drill     独立插件：SQLite 事实库 + 工具面 + UI
      └─ 需要影响提示词时，只通过 mods/ 里的一条中间件接入（不改 dsh-forge）
```

这样演练台可以独立装卸，dsh-forge 的核心也不会因为它的 1.5 万行而失去可测性。

---

## 7. 明确不做的事

1. 不改宿主 `@deepseek-ai/*` 任何文件（无 `.dshpurge.bak`、无 asar 拆包、无 shim 改写）
2. 不改 `process.env`
3. 不静默删除用户开关（purge 会在启动时删 `$DSH_HOME/.hung-disabled`）
4. 不静默宿主崩溃（purge 的 #83/#84）
5. 不删除宿主守护脚本 / 计划任务（purge 的 `stubDoctorSupervisor`）
6. 不做无校验自更新
7. 不实现 L6（权重层），只留 `l6-weights.js` 的接口契约与说明

---

## 8. 落地状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 骨架 + `core/pipeline.js` + `core/text.js` + 单测 | ✅ 完成 |
| P1 | L1b（contexts）+ L5 状态页 | ✅ 完成 |
| P2 | L1（sections）+ 固定 fixtures 回归 | ✅ 完成 |
| P3 | L2 规则中间件（默认关） | ✅ 完成 |
| P4 | L0 config 段 + danger 模块（默认关） | ✅ 完成 |
| P5 | L3（默认关） | ✅ 完成（sync 管线 + WeakMap 稳定身份） |
| P6 | L0 统一能力表（native/env/filesystem/source-patch 四级闸） | ✅ 完成 |
| P7 | 源码补丁引擎（六道闸）+ 补丁目录 | ✅ 完成 |
| P8 | 自更新（绑 GitHub + 强制 sha256） | ✅ 完成 |
| P9 | L4 离线会话工装（zstd） | ✅ 完成 |
| P10 | 提示词链（promptFile → rules → cwd → base，只读用户文件） | ✅ 完成 |
| P11 | EFFECTS 表 + request-retry（验证第三张表能扩） | ✅ 完成 |
| P12 | L0 建议项（4 条 purge 补丁改成 config 展示） | ✅ 完成 |
| P13 | 能力协议中间件（L1b，complete:true 下也不丢） | ✅ 完成 |
| P14 | preview 工具（用宿主 renderPrompt 真实渲染） | ✅ 完成 |
| P15 | 运行时总开关（state.json + 管线闸 + UI 开关 + HTTP op） | ✅ 完成 |
| P15b | 界面收敛为输入框行内 iOS 开关（默认关，无需 slash 命令） | ✅ 完成 |
| P16 | `dsh-forge-drill` 独立插件 | ⬜ 待做（独立项目） |
| — | 自测 | ✅ 90/90 通过，`node --check` 全绿 |

### 8.1 自测覆盖了什么

| 文件 | 断言数 | 覆盖 |
|---|---|---|
| `tests/pipeline.test.js` | 13 | 注册/替换、priority 顺序、层过滤、覆盖开关、内置抛错冒泡 vs mod 只记日志、非数组返回值、runSync 拒 Promise |
| `tests/layers.test.js` | 14 | **幂等性**（跑 10 次结果恒定）、纯函数（不改入参）、剔除段、context 去重、L2 逐 block 改写且保留图片 block、不误伤宿主合成消息 |
| `tests/config.test.js` | 16 | 默认值、config 覆盖、环境变量优先级、danger 联锁、路径解析、loader 跳过 `_` 前缀、CRLF 往返、fingerprint |
| `tests/client.test.js` | 6 | UI 冒烟：极简 React 展开组件树，验证面板渲染、300px 上限、空状态 |
| `tests/effects.test.js` | 11 | 永久错误不重试、预算按 turn+step 独立、下游 decision 优先、max=0 关闭、continue-turn 明确报 unsupported |
| `tests/source.test.js` | 11 | 提示词链五级优先级、规则激活/删除后回落、**从不写用户 AGENTS.md**、建议项来源与改法完整 |
| `tests/capabilities.test.js` | 22 | 能力表结构与默认值、四级成本闸、补丁六道闸（版本/唯一命中/语法回滚/幂等/apply→revert）、L4 zstd 往返与回读校验 |
| `tests/integration.test.js` | 13 | 用假 cordis ctx 跑真实 hook：L1+L1b 同时生效、反复过 hook 无叠加、单层关闭时另一层仍工作、全关时返回原对象、内部抛错原样返回、L2 默认不注册、L3 对象身份稳定、**drop-in mod 自动加载**、坏 mod 不拖垮插件 |

### 8.2 未做 / 明确留白

- **L6**（权重层）：不做。文档中保留定义，不写空壳代码 —— 空壳只会让人以为支持。
  真要接，形态是 `l6-weights.js` 适配器：调外部 abliteration 工具 + 校验产物，不在宿主进程里跑。
- **多 profile 自适应**：当前只声明 `systemPrompt` 一个硬依赖，`webServer` 软取。
  headless / tui 下状态页不可用，但四层改写照常工作。

---

## 9. 一句话总结

> purge 的问题是**用"改宿主源码"这一个手段去实现六个不同层的事情**，所以 82 条补丁按文件散布、跨层耦合、无法单独验收。
> dsh-forge 把轴换回「改哪份数据 × 哪个时机」：**L0 只写 config，L1/L1b/L2/L3 各挂一个官方钩子，L4/L5 边缘化，L6 不碰。**
> 宿主源码零改动，卸插件即完全还原。
