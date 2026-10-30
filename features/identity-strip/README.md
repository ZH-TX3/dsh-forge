# identity-strip — 身份行剥离

**能力**：抹掉宿主那句 `You are an AI agent powered by DeepSeek Harness.`
**落点**：用同名 `harness:identity` 注册空文本 —— scoped 段覆盖 global 同名段。
**失败模式**：`persona` 设 `complete: true` 时是**空操作**（收尾会把 sections 收成单段）。要它生效，得关 complete 改用多段拼装。
**断言**：V-J1、V-J2。
