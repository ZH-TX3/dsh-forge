# capability-protocol — 能力路由协议

**能力**：把「先读 skill/MCP 目录再动手、加载即遵守、子代理继承」这套协议常驻在上下文里。
**落点**：`systemPrompt.context()`。用 context 不用 section —— section 会被 complete 收尾吃掉。
**失败模式**：文件缺失时文本为空（不占位、不抛）；`enabled: false` 整个跳过。
**断言**：V-J3。
