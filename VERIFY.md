# 效果验证

四层阶梯。**越往下越接近真实，越往下越无法自动化** —— 下面三层能自动跑，
最后一层只能人看。跳过任何一层都会有盲区。

| 级 | 验什么 | 跑什么 | 需要 DSH 在跑吗 |
|---|---|---|---|
| L1 | 逻辑正确 | `node --test tests/*.test.js` | 否 |
| L2 | 宿主真代码下的装配 | `node scripts/verify.mjs` | 否 |
| L3 | 渲染结果好不好看 | `node scripts/preview.mjs` | 否 |
| L4 | 模型真的照做了 | 手工（见下） | **是** |

---

## L1 · 单元与集成

```bash
node --test tests/*.test.js
```

覆盖的是「中间件逻辑」：幂等、纯函数、层隔离、错误处理、补丁闸、zstd 往返、能力联锁。
**这一层证明不了 waterfal 真的会调到我们**——它用假 ctx。

## L2 · 真宿主代码（关键的一层）

```bash
node scripts/verify.mjs
node scripts/verify.mjs --json
node scripts/verify.mjs --rounds 50
```

它 import 宿主的**真** `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-system-prompt`，
调宿主自己的 `SystemPrompt.assemble()`，然后断言。15 条检查：

| ID | 断言 | 为什么重要 |
|---|---|---|
| V0 | 宿主可定位且扫到文件 | 扫到 0 个文件时完整性断言会假绿，直接中止 |
| V1 | L1 段落在 sections 首位 | `{global:true, prepend:true}` 是否真生效 |
| V2 | L1b 段在 contexts 里 | 同上 |
| V3 | `harness:identity` 被剔除 | `stripSections` 生效 |
| V4 | `complete:true` 下 L1 消失 | **这是宿主行为，不是 bug**；断言它，才能证明 V5 有意义 |
| V5 | `complete:true` 下 L1b 存活 | **核心断言**：L1b 的整个存在理由 |
| V6 | 只开 L1b 时 sections 干净 | 层隔离 |
| V7 | 只开 L1 时 contexts 干净 | 层隔离 |
| V8 | `enabled:false` 完全不介入 | 总开关真的断干净 |
| V9 | 连续 N 轮零漂移 | purge 曾每轮叠 841 字符 |
| V10 | L2 剥 ChatML | 走真 `agent/pre-step` 派发，不是直调函数 |
| V11 | L3 真的替换 `deriveMessages` | 方法身份变化 + 返回条数不变 |
| V12 | p95 < 20ms | 每步都会跑，慢了就是拖累 |
| V13 | 宿主文件零改动 | 对**全部** `@deepseek-ai` 文件比 sha256 |
| V14 | 环境变量零改动 | 对比 `process.env` 快照 |
| V15 | 负向对照：关掉后断言必须失败 | **防止前面 14 条全是空跑** |

### 实测基线（本机 0.2.0-rc.2）

```
宿主可定位并可扫描      0.2.0-rc.2 @ C:\Users\陈强\.dsh\profiles\node_modules\@deepseek-ai，10096 个文件
通过 16/16

注入 prompts/base.md      1329B   占 system prompt 的 93.2%
L1b context                980B
system prompt 总计        1426B
幂等漂移（20 轮）         0 bytes
assemble 耗时            p50 0.32ms · p95 0.57ms
宿主文件改动              0   （10096 个文件逐个比 sha256）
环境变量改动              0
```

### 指标与阈值

| 指标 | 健康值 | 越界说明 |
|---|---|---|
| **L1 注入命中率** | 100%（非 complete 预设） | 0 = 钩子没注册或 preset 是 complete |
| **L1b 存活率** | 100%（含 complete 预设） | <100% 说明 L1b 前提不成立，整个设计要重想 |
| **幂等漂移** | 0 bytes / 20 轮 | >0 说明有中间件在做自匹配叠加 |
| **`assemble` p95** | < 20ms | 每步都跑，50ms 就要查是不是在跑重活 |
| **宿主文件改动数** | 0 | >0 = 架构承诺被破了（或打了源码补丁） |
| **环境变量改动数** | 0 | >0 = 有隐式副作用 |
| **注入占 system prompt 比** | 自己定，但要知情 | 93% 说明 base.md 相对其它段很大；超 100% 不可能，接近 100% 等于把官方段挤没了 |

## L3 · 看渲染结果

```bash
node scripts/preview.mjs                        # standard 预设
node scripts/preview.mjs --preset minimal       # 模拟 complete:true
node scripts/preview.mjs --layer L2=on --layer L3=on
node scripts/preview.mjs --quiet                # 只看最终文本
```

这条用宿主自己的 `renderPrompt` / `renderContextSections`，所以看到的拼接结果和发给模型的
一字不差。它不做断言，就是给人看的——**检查顺序、分隔、有没有重复段**。

## L4 · 真实会话（只能手工）

自动化的天花板是 hook 层。模型到底有没有照做，只能发一句话看。

```
1. 装插件 → 重启 DSH → 新开会话（新会话才会重新装配）
2. 输入框上方应出现 forge 开关
3. 发一句会触发 base.md 纪律的话，例如：
     「用一句话说明这个仓库做什么」
   观察：有没有铺垫、有没有反问、有没有"我无法"
4. 切到 minimal 预设（complete:true），再发一次
   观察：L1 长人设失效属预期；L1b 那几条短规则应仍然生效
     （不铺垫 / 缺参用占位符 / 不反复确认授权）
5. 打开面板看 journal：应有 assemble 与 L2/L3 的改写记录
6. 关掉总开关，再发一次：行为应回到官方默认
```

### 手工验收清单

| 观察点 | 通过 | 失败说明 |
|---|---|---|
| 新会话第一条就生效 | ☐ | 首轮没注入 → 钩子注册晚于首次 assemble |
| 多轮之间不叠加 | ☐ | 越聊越长 → 幂等破了 |
| 面板数字和实际一致 | ☐ | 面板说 1329B 实际更长 → 状态与实际脱节 |
| 关掉开关行为立刻回默认 | ☐ | 还生效 → 总开关没断到注入路径 |
| 卸载后完全无痕迹 | ☐ | 有残留 → 违反了零改动承诺 |

---

## 一条命令跑完能自动化的部分

```bash
npm run verify     # 语法 + 138 单测 + 16 项真宿主断言
```

任何一项红了就别信"应该没问题"——这个项目的历史上，
**两次假绿都是因为断言没咬到东西**（0 个文件被扫描、L3 方法没被替换却在报通过）。
V15 那条负向对照就是为此加的。
