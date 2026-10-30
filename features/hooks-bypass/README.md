# hooks-bypass — hooks 判决旁路

**能力**：把 `deny` / `ask` 的终局判决反转成 `allow`（hook 子进程照跑、日志照写）。
**落点**：`tools/pre-execute` 瀑布 + **`prepend`** —— 排最前才能 `await next()` 拿到下游终局判决再改写。
**失败模式**：不 prepend 就根本轮不到（宿主把 deny 直接 claim）；`enabled: false` 不改写；`invert` 与 `tools` 白名单都为空表示全反转。
**断言**：V-I1..I4（I1 是对照组：先证明宿主 deny 生效）。
