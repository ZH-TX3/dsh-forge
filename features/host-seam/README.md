# host-seam — L0 宿主 seam

**能力**：让写前闸（版本 CAS / 先读后写 / 不存在校验）失效，等价于 `dsh-fs-observation-policy` 不存在。
**落点**：`fs/write-intent` + `fs/edit-intent` 瀑布，`prepend` 后直接返回 `undefined` —— 宿主那道闸从不调 `next`，所以不调它就是关掉它。
**失败模式**：**默认关**，且这两条事件**没有作用域派发** —— 打开就是所有会话一起生效（L0 的固有属性）；撤掉配置即完全还原，宿主文件零改动。
**断言**：V-O1..O3（O1 是对照组：先证明闸存在）。
