# mods/ —— 拖一个文件进来就是一个新功能

放到本目录的 `.mjs` / `.js` 文件会被自动加载，**改文件即生效**（按 mtime 重新 import），
删掉文件即卸载。不需要改 `index.js`，不需要改配置，不需要重启宿主。

以下划线开头的文件（如 `_example.mjs`）不会被加载，用来放样例和草稿。

## 契约

```js
export default {
  id: 'mod:my-rule',      // 必填，全局唯一。同 id 会覆盖早先注册的（含内置）
  layer: 'L1',            // 必填：L1 | L1b | L2 | L3
  priority: 500,          // 选填，小的先跑，默认 1000
  describe: '一句话',      // 选填，状态页展示
  optional: true,         // 选填，出错时是否只记日志继续（mods 默认 true）
  apply(value, ctx) {     // 必填
    return value          // 必须返回同类型数组；返回 null/undefined = 不改
  },
}
```

`apply` 收到的 `value` 取决于 layer：

| layer | value | 元素形状 |
|---|---|---|
| `L1` | system prompt 段数组 | `{ name, text, order?, interpolate? }` |
| `L1b` | runtime context 段数组 | `{ name, text, order }` |
| `L2` | 本轮用户消息数组 | `{ role, content, source?, ... }` |
| `L3` | 派生给模型的历史消息数组 | 同上（**必须同步**，不能返回 Promise） |

`ctx` 提供：`config`、`journal`、`pipeline`、`promptText`、`contextText`、
`stripSections`、`promptOrder`、`agent`、`session`、`hostContext`。

## 三条铁律

1. **纯函数**。不要读写磁盘、不要发网络请求、不要改全局。要读配置就读 `ctx.config`。
2. **幂等**。同一份输入跑两次，结果必须一样。靠「段名」或「id 标记」判断是否已改过，
   不要靠字符串自匹配（那会每轮叠加一点）。
3. **不要吞异常**。让错误抛出去 —— 管线会记日志并跳过你这个中间件，其它人照常工作。

## 例子

见 `_example.mjs`：L1 改段、L1b 加段、L2 改写用户输入、L3 折叠历史，各一个。
