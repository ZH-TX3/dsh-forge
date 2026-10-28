# 锻造模式（forge）— 架构设计 v2

> 状态：设计，待实现
> 分支：`feat/agent-mode`
> 取代：v1「host 插件 + state.json 双闸 + 源码补丁」形状

---

## 0. 一句话

forge 不再是装在宿主里、对所有会话生效的全局改机插件，而是**一个 Agent 模式**：
模式由 Cordis 预设声明，模式内每一项能力是一个**可独立挂载的模块**，
宿主组合一行不改，**是否生效 = 你是否选了这个模式**。

---

## 1. v1 的三个结构性缺陷

不是代码质量，是形状。

| 缺陷 | 机制 | 后果 |
|---|---|---|
| **全局常驻** | 挂成 host 插件，所有会话共享一份 | 权限放大到每个会话，包括不该被改的那些 |
| **软开关** | `config.enabled` × `state.json` 两个闸 | 存在「静默什么都不做」状态位；`verify`/`preview` 两次假绿就是从这来的 |
| **注入不可撤** | L1 注入写成 `system/message` 事件落进会话历史 | 关插件撤不回历史，旧文案永久留在长会话里 |

v1 拿 `state.json` 兜这些，本质是给一个错的形状加护栏。
预设是正确形状：**不选这个模式，forge 的插件根本不在该会话的插件图里**。

---

## 2. 三条边界

```
宿主层   @deepseek-ai/* 与 profile cordis.patch.yml
         forge 只读。不 insert host 行、不改 process.env、不删用户开关。
              ↑ 唯一例外见 §6 toolbox.patch（显式 CLI，六道闸）
模式层   preset id = forge（显示名「锻造模式」）
         config.plugins = 能力清单。一行一个 feature。
              ↑ 加能力 = 加目录 + 加一行；模式 = 一份清单
数据层   data/prompts/*.md、data/rules/*.md、data/mods/*.mjs
         用户可改，mtime 缓存，改即生效，不需要重装
```

**零源码补丁**从「承诺」变成「结构必然」：模式内能做的事全在 scope 里做完了，
不需要碰 `@deepseek-ai/*` 的文件。

---

## 3. 作用域即闸门（本设计的承重墙）

以下三条来自真宿主类型声明，不是推断：

1. `systemPrompt.section()` / `.context()` 是 **scoped 注册**；
   `system-prompt/assemble` 是 **scope-filtered 派发** —— 有作用域的监听器只收到
   自己 scope 的装配。→ 人设与硬规则只进 forge 会话。
2. `PromptSection.complete` 的语义是「本次装配把它当作唯一 section」，
   而装配本身按 scope 走。→ 整套替换**只在 forge scope 内成立**，不外溢到 standard。
3. 工具注册是 scoped；服务靠 `isolate` 分 realm。
   → 替换 `fs` / `approval` 只影响装进同一 realm 的消费者。

推论：**不需要 `state.json`**。没有开关就没有「开关忘了开」这种失败模式。

---

## 4. 能力 → 落点表

`L` = 落点层。数字是实施阶段。

| # | feature | L | 挂载形态 | 落点 | 阶段 |
|---|---|---|---|---|---|
| 1 | `persona` | 模式 | `systemPrompt.section({complete:true})` | 长人设全文，读 `data/prompts/base.md` | P0 |
| 2 | `rules` | 模式 | `systemPrompt.context()` × n | 硬规则，读 `data/rules/*.md`；`complete` 收尾也不丢 | P0 |
| 3 | `middleware` | 模式 | `system-prompt/assemble` 瀑布 + tools seam | mods 管线，`(同型数组, ctx) => 同型数组` | P1 |
| 4 | `chain` | 模式 | section + context | 思维链协议：thinking 输出、正文剥离、强制工具调用 | P1 |
| 5 | `bypass.fs` | 模式 | `dsh-fs-local` + `dsh-tool-fs`，`isolate: { fs: forge }` | 模式内取消 fs 围栏与 read-before-edit 观察策略 | P2 |
| 6 | `bypass.approval` | 模式 | 注册 answerer，scope 限定 | 模式内 escalation 无条件授信 | P2 |
| 7 | `bypass.hooks` | 模式 | `tools/execute` 包装 | 模式内 hooks deny 旁路 | P2 |
| 8 | `toolbox.patch` | 模式 | 一个 tool + CLI 子命令 | 仅剩必须动宿主的补丁，六道闸 + sha256 + 回滚 | P3 |
| 9 | `toolbox.session` | 模式 | 一个 tool + CLI 子命令 | 会话工装（多帧 zstd 读写、inspect、redact） | P3 |
| 10 | `toolbox.update` | 模式 | CLI 子命令 | 自更新，绑 GitHub + 强制 sha256 | P3 |
| 11 | `toolbox.advice` | 模式 | CLI 子命令 | 宿主本来就能配的项：只建议不代改 | P3 |

**丢弃**：`core/state.js`（双闸）、`backend.js` / `client.js`（Web 开关，模式选择本身就是开关）、
`core/capabilities.js` 的四级成本表（并入 toolbox 的 CLI 参数）。

---

## 5. 模块契约（不耦合的具体含义）

每个 feature 自包含：

```
features/<id>/
├── index.js     export const name / inject / apply(ctx, config)
├── schema.js    Config schema（可选）
└── README.md    一段话：能力、落点、失败模式、验收方式
```

硬规则：

- **不得 import 其他 feature**。共享代码只进 `lib/`（纯函数，无 ctx）。
- **不得读写全局开关**，不得 `process.env` 写，不得碰 `$DSH_HOME` 之外的路径。
- **不得监听别的 scope**；所有注册都带自己作用域。
- **apply 内自兜底**：加载期不抛。一个 feature 挂不上只记日志，其余照常。
  因为预设里任一行激活失败会连累整个预设 —— 这个风险必须由 feature 内部消化。
- **配置只有一种进法**：`config` 参数。没有第二真相源。

---

## 6. 预设清单长这样

```yaml
- insert:
    - id: preset-forge
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: forge
        name: '锻造模式'
        order: 30
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config: { prefix: | <硬规则短版，内联> }
          - id: forge-persona
            name: 'file:///<plugin>/features/persona/index.js'
            config: { file: data/prompts/base.md, complete: true }
          - id: forge-rules
            name: 'file:///<plugin>/features/rules/index.js'
            config: { dir: data/rules }
          # P1 起逐阶段追加
```

**短规则内联、长人设读文件**（已定）：短规则跟随预设版本走，不可能漂；
长人设改 md 即生效，不用重装。

---

## 7. 与 v1 的代码去向

| v1 文件 | 去向 |
|---|---|
| `core/hooks.js` + `core/runner.js` | 降为 `lib/hooks.js`、`lib/runner.js`，被 `features/middleware` 单方面依赖 |
| `core/pipeline.js` + `core/loader.js` | 并入 `features/middleware` |
| `core/source.js` | 并入 `features/persona` + `features/rules`（五级链砍成两级：显式 config > `data/`） |
| `core/config.js` | 砍薄成 `lib/config.js`（只做默认值 + 环境变量覆盖） |
| `core/journal.js` | 留 `lib/journal.js`，供各 feature 记一行 |
| `core/l4.js` / `core/patch.js` / `core/update.js` / `core/advice.js` | 挪 `features/toolbox.*` |
| `layers/builtin.js` | 拆进 `features/chain` 与 `features/middleware` |
| `core/state.js` / `backend.js` / `client.js` / `core/capabilities.js` | 删 |
| `scripts/verify.mjs` | 重写断言（见 §9），仍 import 宿主真包 |

---

## 8. 阶段计划（每阶段独立可安装、可验收）

- **P0 骨架** — 预设声明 + `persona` + `rules` + 最小 verify。
  验收：选 forge 的新会话拿到 base.md 全文与硬规则；standard 会话零变化。
- **P1 管线** — `middleware` + `chain`。验收：mods 丢文件即生效；思维链协议在装配里可见。
- **P2 旁路** — `bypass.fs` / `bypass.approval` / `bypass.hooks`。验收：对照测试见 §9。
- **P3 工装** — 四个 toolbox + CLI。验收：各子命令 dry-run 有输出、真跑有回滚。

每阶段结束提交一次，`main` 不动，全部留在 `feat/agent-mode`。

---

## 9. 验收断言（verify 重写要点）

| ID | 断言 | 为什么咬得住 |
|---|---|---|
| V-A | forge scope 装配含 `base.md` 全文与全部 `rules/*.md` | 正例 |
| V-B | standard scope 装配**逐字节**等于改装前基线 | **负向对照**，防假绿 |
| V-C | 预设卸载后 profile 补丁内 forge 行数为 0 | 结构还原 |
| V-D | forge 会话 fs 写入不受围栏 / standard 会话仍受 | 作用域隔离真的生效 |
| V-E | 任一 feature `apply` 抛错时，其余 feature 仍装配成功 | 失败隔离 |
| V-F | `complete:true` 时硬规则仍在 contexts 里 | v1 的 L1b 发现，必须回归 |

**每条断言必须先证明它会失败**（v1 两次假绿的教训）。

---

## 10. 已知风险

1. **预设行激活失败会连累整个预设** —— 由 §5 的「apply 内自兜底」消化；P0 先做一次故意抛错实验确认。
2. **`isolate` 分 realm 的实例生命周期** —— 需在 P2 实测：模式内 `fs` 替换是否影响同会话宿主工具。
3. **热插拔边界** —— 预设是编译期装配，`mods/` 的热插拔只存在于 `features/middleware` 内层，不承诺跨 feature 热插拔。
4. **会话历史不可撤** 依然成立（结构性问题，非本设计能解）；模式化只是让它不再发生在新会话里。

---

## 11. 实施状态（P1 / P2 已落）

| feature | 状态 | 落点（真宿主） | 断言 |
|---|---|---|---|
| `persona` | 已实现 | `systemPrompt.section(complete)` | V-A1 / V-F |
| `rules` | 已实现 | `systemPrompt.context` | V-A2 / V-F |
| `middleware` | 已实现 | `system-prompt/assemble` 瀑布 | V-G1..G4 |
| `bypass-approval` | 已实现 | `approval/request` 瀑布（agent 作用域） | V-H1..H3 |
| `hooks-bypass` | 已实现 | `tools/pre-execute` 瀑布 + `prepend` | V-I1..I4 |
| `capability-protocol` | 已实现 | `systemPrompt.context` | V-J3 |
| `identity-strip` | 已实现 | 同名 scoped `section` 覆盖 | V-J1 / V-J2 |
| `request-retry` | 已实现 | `agent/request-error` 瀑布 | V-K1..K4 |
| `auto-continue` | 已实现（默认关） | `agent/status` + `session/event` | V-L1..L5 |
| `bypass-fs` | 待做（需实验） | 换 `ctx.fs` provider | — |
| `toolbox.*` | 待做 | 模式内命令 | — |

### 两条从 purge 那边换来的教训

1. **`approval` policy 不能设 `never`。** 宿主的 never 分支在 `decide()` 里
   先于 waterfall 返回 `'rejected'`（fail-closed 承诺的一部分），监听器根本收不到请求。
   零补丁方案的前提是 policy = `'ask'` + 终端 answerer。照抄 purge 的
   `Config.policy = never` 会把自己锁死在监听器缝外。
2. **hooks 判决只能 prepend + await next() 改写，不能「替它决定」。**
   宿主把 hooks 的 deny 直接 claim，排在它后面就轮不到你；排它前面又不知道它会怎么判。
   唯一正确姿势是先让下游跑完再换终局判决 —— 副作用不减，换的只是结论。

## 12. 与 dsh-purge 的能力对照（逐项，勿重复劳动）

| purge 的做法 | forge 的落点 | 结论 |
|---|---|---|
| #6 seatbelt `deny file-write*` → `allow` | 换 `ctx.fs` provider（`dsh-fs-local` 替代 `dsh-fs-sandbox`） | 可等价，待做 |
| #15 `confine()` 返回未包裹 argv | 同上，或换 `ctx.sandbox` provider | 可等价，待做 |
| #16 `checkedTarget()` 直接 `return target` | 同上（provider 不带围栏即无检查） | 可等价，待做 |
| #17 观察策略 `writeIntent/editIntent` 返回 void | 不 compose `dsh-fs-observation-policy` | 需实测：宿主是全局挂的，预设能否隔离 |
| #9 `ApprovalService.decide()` 恒返 `allowed-once` | `approval/request` 终端 answerer | **已实现**（policy 必须留在 ask） |
| #13/#14 `approveEscalation()` 缺审批时授信 | 同上，answerer 授信后不必动阶梯 | **已实现**（副作用同 #9） |
| #30/#31/#64/#65 hooks deny 哨兵字符串 | `tools/pre-execute` prepend + 反转终局判决 | **已实现** |
| #7/#8 `sandbox-policy.mode` / `user-approval.policy` 改默认 | 会话策略变化，属产品级 Permissions，不由模式代改 | 有意不做 |
| #5/#11/#12 prompt 常量 NEVER/ASK_SENTENCE | 需 `systemPrompt.context` 同名覆盖（order 语义未验证） | 未验证 |
| capability-protocol（skills/MCP 路由协议） | `systemPrompt.section`，零补丁可搬 | 待做（并入 `chain`） |
| settle-policy（启动落定窗口） | 无对应：forge 不改宿主，没有要重打的东西 | 不需要 |
| 反替换表（8 条 find/replace） | 无对应：不留宿主动过的痕迹 | 不需要 |
