# bypass-approval — 授信旁路

**能力**：模式内工具审批直接放行（返回 `allowed-once`，宿主唯一认可的 grant）。
**落点**：`approval/request` 瀑布（agent 作用域派发），终端 answerer。
**失败模式**：会话 approval policy 若是 `never`，宿主的拒绝发生在监听器缝之外，本模块**收不到请求**（宿主语义，不是 bug）；`allow` 白名单未命中的一律 `next()` 交回人工。
**断言**：V-H1..H3（纯判决）、V-H4a/b/c（真瀑布派发 + 对照组）。
