# dsh-forge

把「改送给模型的数据」拆成四层，每层一个官方钩子，核心只提供一条中间件管线。
**零源码补丁**——不写任何 `@deepseek-ai/*` 文件，卸载即完全还原。

> 本插件是 `dsh-purge` 的重写：目标一致（在宿主侧把提示词/上下文按自己的意图装配），
> 手段完全不同。架构与决策记录见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

---

## 四层

| 层 | 改什么 | 钩子 | 默认 |
|---|---|---|---|
| **L1** | system prompt（`assembly.sections`） | `system-prompt/assemble` | 开 |
| **L1b** | runtime context（`assembly.contexts`） | `system-prompt/assemble` | 开 |
| **L2** | 本轮用户消息 | `agent/pre-step` | 关 |
| **L3** | 派生给模型的历史 | 包装 `session.deriveMessages` | 关 |

**L1b 是重点。** `complete:true` 的预设（minimal / persona-complete）会把所有 sections
丢掉，但永远不会丢 contexts。所以：

- 长人设 → `prompts/base.md`（L1，可能被丢）
- 必须永远生效的硬规则 → `prompts/context.md`（L1b，一定在）

L0 是**基座不是层**：沙箱模式 / 审批策略这些是宿主 config，本插件只读不写。

除四层之外还有两样东西，分开放是因为它们不是「改数组」：

- **EFFECTS**（行为注入）：如请求失败自动重试 —— 挂监听器，没有输入输出数组
- **提示词链**：提示词正文从哪儿来，一条优先级链

---

## 安装

```bash
# 从本地目录装（开发用）
dsh plugin --profile web add /d/ds/plugins/dsh-forge

# 或者在 profile 的 cordis.patch.yml 里手动加一行
```

装完重启宿主。设置页 / 会话输入框上方会出现 `forge L1 L1b ▼` 的小条。

---

## 配置

`cordis.patch.yml` 里的 `config` 段，完整默认值见文件本身。常用的几个：

```yaml
- insert:
    - id: dsh-forge
      name: dsh-forge
      config:
        promptFile: ""            # 空 = prompts/base.md；可填绝对路径
        stripSections: [harness:identity]   # 从 sections 里剔除的段
        layers: { L1: true, L1b: true, L2: false, L3: false }
        l0:
          danger:
            enabled: false        # 总闸，关着时下面两项强制归零
            autoApprove: false    # approval/request → allowed-once（审计事件仍完整落盘）
```

排障时可以临时用环境变量覆盖：`DSH_FORGE_L2=1`、`DSH_FORGE_VERBOSE=1`、`DSH_FORGE_ENABLED=0`。

---

## 提示词链

优先级从高到低，第一个非空胜出：

```
1. config.promptFile                  显式指定
2. $DSH_HOME/forge/rules/<active>.md  多套提示词，靠 active.json 切换
3. <cwd>/AGENTS.md                    项目级
4. <cwd>/CLAUDE.md                    项目级
5. prompts/base.md                    插件自带默认
```

```
node scripts/forge.mjs prompt list      # 有哪些、当前用哪个
node scripts/forge.mjs prompt use work  # 激活 rules/work.md
node scripts/forge.mjs prompt off       # 取消激活
node scripts/forge.mjs prompt show      # 当前正文全文
```

**只读你的 `AGENTS.md` / `CLAUDE.md`，从不写。** purge 会覆盖它们，这里刻意不做。
`promptSource: file` 可把链收窄成「只认 promptFile」。

## 效果（EFFECTS）

| 效果 | 默认 | 说明 |
|---|---|---|
| `request-retry` | on | 宿主在 `agent/request-error` 默认不重试。本效果在非永久错误上返回 `{kind:"retry"}`，按 turn+step 计预算（默认 3） |
| `continue-turn` | off | **未实现**。宿主 `agent/status` 只 emit `{status}`，拿不到 agent 句柄，无法安全补发 followup。留占位不猜 API |

```yaml
effects:
  request-retry: { enabled: true, max: 3 }
  continue-turn: { enabled: false }
```

## L0 建议项（本来就不用打补丁）

purge 有 4 条补丁改的其实是宿主 config。这里只展示「怎么改」，不替你做：

```
node scripts/forge.mjs advice
```

覆盖：沙箱模式、审批策略、读文件上限（`dsh-tool-fs.readLimit/readMaxBytes`）、
子代理深度（`dsh-tool-subagent.maxDepth`）、持久 shell 超时（在预设 YAML 里）。

## 开关（输入框那一行）

界面上只有一样东西：输入框底部那一行（`.uV2eYG_row`）里，紧挨 `+` 和权限下拉之后，
一个 **iOS 风格的开关**。轨道 32×18、圆角 9、iOS 绿 `#34c759`，关闭是系统 32% 灰。

| 状态 | 含义 |
|---|---|
| 关（灰） | 四层改写、能力、效果**全部不生效**（默认） |
| 开（绿） | 全部生效 |

**默认关。** 装上插件不等于立刻改行为 —— 要拨一下。

它在 `conversation.input.left` 插槽里（`kind:"list"`，`scope:"session"`），
渲染位置正好是 `.row` 内 `.modes`（权限下拉）之后、`.trailing` 之前。

状态落 `$DSH_HOME/dsh-forge/state.json`，与 cordis 配置分开：

```json
{ "enabled": true }
```

- 开关：`POST /dsh-forge/api?op=toggle`
- 终端等价操作：`node scripts/forge.mjs switch on | off | status`
- 想彻底重置：删掉 `$DSH_HOME/dsh-forge/state.json`（回到默认关）

开关拨动**不需要重启**，也不用刷新页面 —— 钩子始终接线，只是被 `isActive()` 挡住。

## 看效果：preview

```
node scripts/preview.mjs                     # 走真实管线，用宿主自己的 renderPrompt 渲染
node scripts/preview.mjs --preset minimal    # 模拟 complete:true：L1 失效、L1b 保留
node scripts/preview.mjs --cwd D:\ds\plugins
node scripts/preview.mjs --layer L2=on --layer L3=on
```

它不模拟渲染器 —— 直接 import 宿主的 `renderPrompt` / `renderContextSections`，
所以看到的拼接结果和宿主发给模型的一模一样。

## 扩展的三档

| 想做的事 | 改哪里 | 重启 |
|---|---|---|
| 加一个中间件 | `mods/xxx.mjs` | 不用（改文件即生效） |
| 加一个效果 | `core/effects.js` 的 `EFFECTS` 加一行 | 要 |
| 加一层（如 L4 = 工具清单） | `core/hooks.js` 的 `LAYERS` 加一行 | 要 |
| 接一个新钩子 | `core/hooks.js` 的 `HOOKS` 加一行 | 要 |

三档的分界线是有意的：**内容可热插拔，结构要显式。**
层和钩子是架构决策，允许运行时漂移会让关闭语义、UI 展示、测试断言全部不可预测。

`index.js` 里没有 `if (L1)` / `if (L2)` 这类分支 —— 它只是 `for (const hook of HOOKS) hook.install(...)`。

## 加一个功能 = 丢一个文件进 `mods/`

不用改 `index.js`，不用改配置，不用重启。改文件即生效（按 mtime 重新 import），删文件即卸载。

```js
// mods/my-rule.mjs
export default {
  id: 'mod:my-rule',
  layer: 'L1',            // L1 | L1b | L2 | L3
  priority: 500,          // 小的先跑
  describe: '一句话说明',
  apply(sections) {       // 必须返回同类型数组；返回 null = 不改
    return sections
  },
}
```

`apply` 的 `value` 按层不同：

| layer | value | 元素形状 |
|---|---|---|
| `L1` | system prompt 段 | `{ name, text, order?, interpolate? }` |
| `L1b` | runtime context 段 | `{ name, text, order }` |
| `L2` | 本轮用户消息 | `{ role, content, source? }` |
| `L3` | 历史消息（**必须同步**） | 同上 |

**三条铁律**：纯函数、幂等（靠 id/段名判断，不靠字符串自匹配）、让异常抛出去
（管线会记日志并跳过你，其它中间件照常）。

完整样例见 [`mods/_example.mjs`](./mods/_example.mjs)，契约细则见 [`mods/README.md`](./mods/README.md)。

---

## 状态

```
GET  /dsh-forge/api?op=state            配置、层开关、中间件清单、prompt 字节数、宿主策略
GET  /dsh-forge/api?op=journal&n=40     最近变更（含 errs）
POST /dsh-forge/api?op=reload           清提示词缓存 + 重载 mods
POST /dsh-forge/api?op=clear            清日志
```

只接受回环来源，全部是只读或重载，没有写配置的入口——
状态页看到的东西必须和管线实际行为一致，不能让 UI 变成第二份真相。

---

## L0 能力表（统一参数）

宿主权限相关的一切都在这张表里，**默认全关**，按需逐项打开。
每项声明自己的成本等级 —— 成本越高，前置闸越多：

| 能力 | 成本 | 要过什么闸 |
|---|---|---|
| `auto-approve` | native | 无。走官方 `approval/request` waterfall，审计事件仍完整落盘 |
| `scrub-permission-env` | env | 无。进程内可还原 |
| `remove-doctor-supervisor` | filesystem | 需 CLI + `--destructive`；自动导出任务 XML、复制脚本到 `backup/`，`cap revert` 可完全还原 |
| `suppress-host-crash` | source-patch | 需 `l0.sourcePatch.enabled` + CLI + 版本白名单 + 语法校验 |
| `escalation-ladder-bypass` | source-patch | 同上 |

```
node scripts/forge.mjs cap list
node scripts/forge.mjs cap apply remove-doctor-supervisor --destructive
node scripts/forge.mjs cap revert remove-doctor-supervisor
```

**宿主运行时只自动应用 native / env。** filesystem 与 source-patch 永不自动执行 ——
不在启动时静默动手，是设计约束不是建议。

## 源码补丁：数据 + 六道闸

补丁本身在 `patches/catalog.js`，是纯数据。加一条不用改引擎。

```js
{
  id: 'sandbox-escalation-widening-exempt',
  file: 'dsh-sandbox/lib/index.js',
  hostVersions: ['0.2.0-rc.2'],   // 版本白名单
  marker: '[dsh-forge] escalation widening exempt',
  find: '…必须在文件里唯一命中…',
  replace: '…',
}
```

引擎（`core/patch.js`）强制走六道闸：

1. 总闸 `l0.sourcePatch.enabled`（默认 false）
2. `hostVersions` 必须包含当前宿主版本
3. 目标文件在、marker 未写、`find` **唯一命中**（0 或 >1 都拒绝）
4. dry-run 先出 diff，不写盘
5. 写前记 sha256 + `.forge.bak`（只建一次）
6. 写后 `node --check`；**失败自动回滚**

```
node scripts/forge.mjs patch list
node scripts/forge.mjs patch preview sandbox-escalation-widening-exempt
node scripts/forge.mjs patch apply sandbox-escalation-widening-exempt
node scripts/forge.mjs patch revert sandbox-escalation-widening-exempt
```

`patch list` 会对着你**当前装的宿主**逐个验证 find 串是否还能唯一命中 ——
升级宿主后先跑它，不要盲打。

## 自更新：绑 GitHub，但必须钉哈希

```yaml
update:
  repo: ZH-TX3/dsh-forge
  ref: main
  sha256: ""        # 空 = 只允许 check，apply 直接拒绝
```

```
node scripts/forge.mjs update check     # 解析 ref → commit sha，看远版本与认证状态
node scripts/forge.mjs update pin       # 下载并算出归档 sha256（不写盘、不应用）
node scripts/forge.mjs update apply     # 需要 sha256 已钉住
```

**私有仓库必须带 token。** GitHub 对无凭据的私有仓库返回 **404 而不是 403**，很容易误判成
"仓库不存在"。token 优先级：`update.token` > `GITHUB_TOKEN` > `GH_TOKEN` > 本机 `gh auth token`。

钉住当前版本：

```bash
node scripts/forge.mjs update pin
#   sha256: "803872c3…"
# 把这行写进 cordis.patch.yml 的 update 段
```

流程：`ref` → commit sha（内容寻址，不能悄悄换内容）→ 按 sha 下载（不按 branch）→
算 sha256 与配置比对 → 不一致中止 → 解压到临时目录 → 备份现有插件 → 整体替换 → 失败回滚。

**没有配置 sha256 就只允许 check。** 这条不可绕过 —— 自更新是供应链面，便利性排在正确性后面。

## L4 会话工装（离线）

会话文件是 `session.jsonl.zstd`（zstd 压缩 JSONL），Node 24 自带 zstd，零依赖。

```
node scripts/forge.mjs session list
node scripts/forge.mjs session stat <file>
node scripts/forge.mjs session redact <file> --pattern 'hunter\d' --apply
node scripts/forge.mjs session restore <file>
```

注意：DSH 的会话文件是**多帧 zstd 拼接**的（追加写），而 Node 的 zstd 解码**只解第一帧**
且不报错。本工具的读路径按帧头逐帧解压、任一帧失败即中止（不退化成静默截断），
写路径输出单帧。这类地方一旦按"能跑就行"写，就是悄悄毁会话。
每次写盘强制：结构复核 → 备份 → 写 → 回读验证（行数 / type 字段），失败自动回滚。

## 开发

```bash
node --check index.js backend.js
node --test tests/*.test.js      # 140 个断言
```

`tests/extensibility.test.js` 证明「加层是数据变更」：用自定义 `LAYERS` 表（多出 `L4`/`L5`）
直接驱动 `Pipeline` + `runner`，全程不碰 `index.js`。

`tests/capabilities.test.js` 证明「补丁闸真的会挡」：版本不匹配、find 不唯一、语法错误、
幂等、apply→revert 全链路，以及 filesystem 能力在宿主运行时确实不执行。

目录职责见 `ARCHITECTURE.md` §3。
