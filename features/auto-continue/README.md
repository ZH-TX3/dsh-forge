# auto-continue — 异常结束后自动续跑

**能力**：结束原因属于 error/aborted/interrupted/max-tokens 且没干完时，280ms 后 `agent.followup('继续')`。
**落点**：`session/event`（记 `turn/end`）+ `agent/status`（idle 时起定时器）。
**失败模式**：**默认关** —— 那 280ms 与用户自己按提交是竞态；外部取消五因（user/cancel/parent/hook/disposed）全挡；连续失败 3 次停手；dispose 清定时器。
**断言**：V-L1..L5（判决链）、V-L6..L8（接线与 dispose）、V-L9（对照：关掉即不发）。
