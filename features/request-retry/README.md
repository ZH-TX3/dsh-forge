# request-retry — 请求失败兜底重试

**能力**：宿主自己的重试策略放弃后，按预算再补一次 `{ kind: 'retry' }`。
**落点**：`agent/request-error` 瀑布。先 `await next()`，宿主已决定 retry 就完全让路。
**失败模式**：终态码（HTTP 400/401/403/404/405/409/422、码名含 AUTH/PERMISSION/…、`permanent` 表）不补；`signal.aborted` 不补；预算按 `(agent, turn, step)` 计数。
**断言**：V-K1..K4。
