# persona — L1 长人设

**能力**：用 `data/prompts/base.md` 整套替换系统提示词（工具 schema 与 contexts 不受影响）。
**落点**：`systemPrompt.section({ complete: true })`，注册在预设作用域内，不外溢到别的模式。
**失败模式**：文件缺失时注册期自动降级为 `complete: false`（宁可人设缺席，不可把 prompt 清成占位符）；与 `identity-strip` 互斥 —— complete 收尾会吃掉同名段。
**断言**：V-A1、V-F、V-J2。
