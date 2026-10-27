window.__ModuleLoader__.load({
  id: "dsh-forge",
  factory: (require) => {
    const react = require("react")
    const h = react.createElement
    const { useState, useEffect, useCallback, useRef } = react

    const API = "/dsh-forge/api"
    const POLL_MS = 5000

    async function api(op, opts = {}) {
      const url = `${API}?op=${encodeURIComponent(op)}${opts.qs ? "&" + opts.qs : ""}`
      const res = await fetch(url, {
        method: opts.method || "GET",
        headers: { accept: "application/json" },
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return res.json()
    }

    const styles = {
      chip: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 6,
        border: "1px solid var(--dsh-border, rgba(127,127,127,.28))",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: 12,
        cursor: "pointer",
        opacity: 0.72,
      },
      dot: (on) => ({
        width: 6,
        height: 6,
        borderRadius: 3,
        background: on ? "var(--dsh-success, #3fb950)" : "var(--dsh-muted, #8b949e)",
        opacity: on ? 1 : 0.35,
      }),
      panel: {
        border: "1px solid var(--dsh-border, rgba(127,127,127,.28))",
        borderRadius: 8,
        padding: 10,
        marginBottom: 8,
        fontSize: 12,
        lineHeight: 1.6,
        background: "var(--dsh-surface, transparent)",
      },
      row: { display: "flex", justifyContent: "space-between", gap: 12 },
      dim: { opacity: 0.6 },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
      err: { color: "var(--dsh-danger, #f85149)" },
      table: { width: "100%", borderCollapse: "collapse", marginTop: 6 },
      th: { textAlign: "left", fontWeight: 600, opacity: 0.6, padding: "2px 6px 2px 0" },
      td: { padding: "2px 6px 2px 0", verticalAlign: "top" },
    }

    function LayerRow({ id, on, count, title }) {
      return h(
        "div",
        { style: styles.row },
        h(
          "span",
          null,
          h("span", { style: { ...styles.dot(on), display: "inline-block", marginRight: 6 } }),
          h("span", { style: styles.mono }, id),
          h("span", { style: { ...styles.dim, marginLeft: 6 } }, title),
        ),
        h("span", { style: styles.dim }, `${count} mw`),
      )
    }

    function Panel({ state, journal, onReload, busy }) {
      if (!state) return h("div", { style: styles.panel }, "dsh-forge: 读取状态中…")
      // 层清单由后端提供（state.layerMeta），UI 不硬编码层名 —— 加层时前端不用改。
      const layers = Array.isArray(state.layerMeta)
        ? state.layerMeta.map((m) => [m.id, m.title || ""])
        : Object.keys(state.layers || {}).map((id) => [id, ""])
      return h(
        "div",
        { style: styles.panel },
        h(
          "div",
          { style: styles.row },
          h("strong", null, "dsh-forge"),
          h(
            "span",
            { style: styles.dim },
            `${state.prompt.bytes}B prompt · ${state.context.bytes}B ctx · ${(state.mods.files || []).length} mods`,
          ),
        ),
        h(
          "div",
          { style: { marginTop: 6 } },
          layers.map(([id, title]) =>
            h(LayerRow, { key: id, id, title, on: !!state.layers[id], count: state.counts[id] || 0 }),
          ),
        ),
        state.mods && state.mods.errors && state.mods.errors.length
          ? h(
              "div",
              { style: { ...styles.err, marginTop: 6 } },
              `mods 加载失败 ${state.mods.errors.length} 个：${state.mods.errors
                .map((e) => e.file)
                .join(", ")}`,
            )
          : null,
        journal && journal.items && journal.items.length
          ? h(
              "table",
              { style: styles.table },
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  h("th", { style: styles.th }, "层"),
                  h("th", { style: styles.th }, "中间件"),
                  h("th", { style: styles.th }, "动作"),
                  h("th", { style: styles.th }, "说明"),
                ),
              ),
              h(
                "tbody",
                null,
                journal.items
                  .slice(-6)
                  .reverse()
                  .map((item, index) =>
                    h(
                      "tr",
                      { key: index },
                      h("td", { style: styles.td }, item.layer || "-"),
                      h("td", { style: { ...styles.td, ...styles.mono } }, item.id || "-"),
                      h("td", { style: { ...styles.td, ...(item.op === "error" ? styles.err : null) } }, item.op),
                      h("td", { style: { ...styles.td, ...styles.dim } }, String(item.note || "").slice(0, 60)),
                    ),
                  ),
              ),
            )
          : h("div", { style: { ...styles.dim, marginTop: 6 } }, "暂无变更记录"),
        h(
          "div",
          { style: { marginTop: 8, display: "flex", gap: 8 } },
          h(
            "button",
            {
              style: { ...styles.chip, cursor: busy ? "default" : "pointer" },
              disabled: busy,
              onClick: onReload,
            },
            busy ? "重载中…" : "重载 mods / 提示词",
          ),
          h(
            "span",
            { style: { ...styles.dim, alignSelf: "center" } },
            state.host && state.host.sandboxMode ? `sandbox=${state.host.sandboxMode}` : "",
          ),
          h(
            "span",
            { style: { ...styles.dim, alignSelf: "center" } },
            state.host && state.host.approvalPolicy ? `approval=${state.host.approvalPolicy}` : "",
          ),
        ),
      )
    }

    function ForgeDock() {
      const [open, setOpen] = useState(false)
      const [state, setState] = useState(null)
      const [journal, setJournal] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState("")
      const alive = useRef(true)

      const refresh = useCallback(async () => {
        try {
          const next = await api("state")
          if (!alive.current) return
          setState(next)
          setError("")
          if (open) setJournal(await api("journal", { qs: "n=20" }))
        } catch (err) {
          if (alive.current) setError(String(err && err.message ? err.message : err))
        }
      }, [open])

      useEffect(() => {
        alive.current = true
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [refresh])

      const onReload = useCallback(async () => {
        setBusy(true)
        try {
          await api("reload", { method: "POST" })
          await refresh()
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        } finally {
          setBusy(false)
        }
      }, [refresh])

      const activeLayers = state
        ? Object.keys(state.layers || {})
            .filter((id) => state.layers[id])
            .join(" ")
        : ""

      return h(
        "div",
        null,
        open
          ? h(Panel, { state, journal, onReload, busy })
          : null,
        h(
          "button",
          { style: styles.chip, onClick: () => setOpen((v) => !v), title: "dsh-forge 状态" },
          h("span", { style: styles.dot(!!state && state.enabled) }),
          h("span", null, `forge ${activeLayers || "—"}`),
          open ? h("span", { style: styles.dim }, "▲") : h("span", { style: styles.dim }, "▼"),
          error ? h("span", { style: styles.err }, "!") : null,
        ),
      )
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("conversation.input.dock", () =>
          ctx.slots.register(
            {
              name: "conversation.input.dock",
              id: "dsh-forge-status",
              order: 20,
            },
            ForgeDock,
          ),
        )
      },
    }
  },
})
