# middleware — 中间件管线

**能力**：`data/mods/*.mjs` 丢文件即生效，契约 `(同型数组, ctx) => 同型数组`；字段 `sections / contexts / tools / assembly`。
**落点**：`system-prompt/assemble` 瀑布（作用域内），先 `await next()` 再按字段依次改写。
**失败模式**：mod 抛错只记日志并保留上一版值；目录空则直通；热重载指纹是 `文件名+mtime+size`，且**必须进 import URL**（Node 的 ESM 缓存按 URL 走）。
**断言**：V-G1..G4、V-D、V-N。
