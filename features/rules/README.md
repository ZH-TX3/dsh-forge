# rules — L1b 硬规则

**能力**：`data/rules/*.md` 一条一个 context，`complete` 收尾也吃不掉。
**落点**：`systemPrompt.context()`，order = 基准 + 文件序号，文件名前缀即顺序。
**失败模式**：目录不存在 = 没有硬规则（不报错）；单条注册失败只记日志，其余照挂。
**断言**：V-A2、V-A3、V-F。
