# dsh-forge — 锻造模式

一个 **DSH agent 预设**，不是一个全局改机插件。

选「锻造模式」的会话才有 forge 的能力；不选，插件图里连一行都没有。
这不是靠开关兜住的，是 Cordis 预设作用域的结构必然。

```
宿主组合（profile / @deepseek-ai/*）   ← 一行不改
        ↑
预设 preset-forge（显示名：锻造模式）   ← 能力清单，一行一个 feature
        ↑
数据层 data/（人设、硬规则、mods）       ← 改文件即生效
```

## 装

```bash
# 在 DSH 里，danger-full-access 或批准一次
plugin_manager install_bundle target=D:\ds\plugins\dsh-forge
```

装完在会话创建处选「锻造模式」。想卸：`plugin_manager remove_bundle target=@local/dsh-forge`，
profile 里不留任何 forge 行。

## 用

| 想改什么 | 改哪 |
|---|---|
| 长人设（整套替换默认 system prompt） | `data/prompts/base.md` |
| 必须生效的短规则 | `data/rules/*.md`（文件名前缀即顺序） |
| 中间件（改装配的 sections / contexts / tools） | `data/mods/*.mjs`，丢文件即生效 |
| 授信放行哪些工具 | `cordis.patch.yml` 里 `forge-bypass-approval.allow`（`['bash*']`，空数组 = 全放） |
| 反转哪些 hooks 判决 | `forge-hooks-bypass.invert`（默认 `deny` + `ask`）与 `tools` 白名单 |
| 挂哪些能力 | `cordis.patch.yml` 的 `config.plugins` |

### 两个旁路的前提

- **授信旁路**要求会话 approval policy 是默认的 `ask`。宿主把 `never` 的拒绝放在
  监听器缝之外，切到 `never` 时本功能静默失效 —— 那是宿主语义，不是 bug。
- **hooks 判决旁路**是「先让下游跑完，再换终局判决」，不是「跳过 hooks」。
  hook 子进程照跑、日志照写，被换掉的只有结论。

三条语义，来自真宿主类型声明：

1. `systemPrompt.section/context` 是 **scoped 注册**，`system-prompt/assemble` 是
   **scope-filtered 派发** → 人设只进本模式的装配。
2. `complete: true` 让本段成为唯一 prompt section，**该语义也只在本 scope 内成立**。
3. `contexts` 永远保留 —— 这就是为什么硬规则放 `data/rules/`，长人设放 persona。
   v1 踩过的坑，在 v2 是结构保证。

读文件按 mtime+size 缓存，存盘即下一次装配生效，不用重装、不用重启。

## 验

```bash
npm run verify          # 或 node scripts/verify.mjs --json
```

用**真宿主**跑真装配：同一个宿主两个 scope，一个选模式、一个不选，
断言两边不同，并且不选的那边逐字节干净（负向对照）。

当前断言：`V-A` 正例、`V-B` 负向对照、`V-C` 宿主零侵入与清单一致性、
`V-D` 数据热更新、`V-E` 失败隔离、`V-F` complete 与 contexts 并存、
`V-G` 中间件管线（含热重载与 mod 抛错隔离）、`V-H` 授信判决、`V-I` hooks 判决反转（真瀑布）。

## 目录

```
cordis.patch.yml        模式声明（只 insert 预设行）
data/prompts/base.md    L1 长人设
data/rules/*.md         L1b 硬规则
features/<id>/          能力模块：index.js + README，不得 import 另一个 feature
data/mods/*.mjs         中间件（下划线开头不加载）
lib/                    纯函数与 I/O（files、journal）
scripts/verify.mjs      真宿主断言
MODE.md                 架构设计与阶段计划
```

## 加一个能力

1. `features/<id>/index.js` 导出 `{ name, inject, apply(ctx, config) }`。
2. `cordis.patch.yml` 的 `plugins:` 加一行。
3. 重装 bundle。

铁律：**apply 内自兜底，加载期不抛** —— 预设里任一行激活失败会连累整个预设，
错误必须在模块内部消化。模块之间不互相 import。

## 已知边界

- 模式是编译期装配：`mods/` 的热插拔只会在 `features/middleware` 内部实现，不承诺跨 feature。
- 会话历史不可撤：被注入过的旧会话，换模式也撤不回已写进历史的内容。
- 本仓库仍在 `feat/agent-mode` 上推进，`main` 是 v1。
