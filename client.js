window.__ModuleLoader__.load({
  id: "dsh-forge",
  factory: (require) => {
    const react = require("react")
    const h = react.createElement
    const { useState, useEffect, useCallback, useRef } = react

    const API = "/dsh-forge/api"
    const PANEL_WIDTH = 300
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
      // 窄栏：固定 300px 上限，不随插槽撑宽。
      panel: {
        width: "100%",
        maxWidth: PANEL_WIDTH,
        boxSizing: "border-box",
        overflow: "hidden",
        border: "1px solid var(--dsh-border, rgba(127,127,127,.28))",
        borderRadius: 8,
        padding: 10,
        marginBottom: 8,
        fontSize: 12,
        lineHeight: 1.6,
        background: "var(--dsh-surface, transparent)",
      },
      // 容器也卡住宽度，避免外层块级元素把面板和 chip 拉到两端。
      // composerStack 是 flex-direction:column，而本插槽在输入框之前；
      // 宿主没有「输入框下方」的插槽，所以用 order 把它排到最后（= 输入框下方）。
      shell: {
        maxWidth: PANEL_WIDTH,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        order: 1,
        marginTop: 4,
      },
      grow: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      row: { display: "flex", justifyContent: "space-between", gap: 8, minWidth: 0 },
      journalLine: {
        display: "flex",
        gap: 6,
        minWidth: 0,
        fontSize: 11,
        lineHeight: 1.5,
        opacity: 0.85,
      },
      toggle: (on) => ({
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 8px",
        borderRadius: 999,
        border: "1px solid var(--dsh-border, rgba(127,127,127,.35))",
        background: on ? "var(--dsh-success-bg, rgba(63,185,80,.15))" : "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: 11,
        cursor: "pointer",
        opacity: on ? 1 : 0.65,
      }),
      offBanner: {
        marginTop: 6,
        fontSize: 11,
        opacity: 0.75,
        lineHeight: 1.5,
      },
      sep: {
        marginTop: 6,
        marginBottom: 6,
        borderTop: "1px solid var(--dsh-border, rgba(127,127,127,.18))",
      },
      dim: { opacity: 0.6 },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
      err: { color: "var(--dsh-danger, #f85149)" },
      journalBox: { maxHeight: 140, overflowY: "auto", overflowX: "hidden" },
    }

    function LayerRow({ id, on, count, title }) {
      return h(
        "div",
        { style: styles.row, title },
        h(
          "span",
          { style: { ...styles.grow, display: "flex", alignItems: "center", gap: 6 } },
          h("span", { style: styles.dot(on) }),
          h("span", { style: styles.mono }, id),
          h("span", { style: { ...styles.dim, ...styles.grow } }, title || ""),
        ),
        h("span", { style: { ...styles.dim, flex: "0 0 auto" } }, `${count} mw`),
      )
    }

    function Panel({ state, journal, onReload, onToggle, busy }) {
      if (!state) return h("div", { style: styles.panel }, "dsh-forge: 读取状态中…")
      const on = state.enabled !== false
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
          h("strong", { style: { flex: "0 0 auto" } }, "dsh-forge"),
          h(
            "button",
            {
              type: "button",
              style: styles.toggle(on),
              onClick: onToggle,
              title: on ? "点击关闭：四层改写与效果全部停用" : "点击打开",
              "aria-pressed": on ? "true" : "false",
            },
            on ? "开" : "关",
          ),
          h(
            "span",
            { style: { ...styles.dim, ...styles.grow, flex: "1 1 auto", textAlign: "right" } },
            `${state.prompt.bytes}B · ${state.context.bytes}B · ${(state.mods.files || []).length} mods`,
          ),
        ),
        on
          ? null
          : h(
              "div",
              { style: styles.offBanner },
              "总开关已关闭：四层改写、能力、效果全部不生效（配置未变，打开即恢复）。",
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
        h("div", { style: styles.sep }),
        journal && journal.items && journal.items.length
          ? h(
              "div",
              { style: styles.journalBox },
              journal.items
                .slice(-8)
                .reverse()
                .map((item, index) =>
                  h(
                    "div",
                    { key: index, style: styles.journalLine, title: `${item.id || ""} ${item.note || ""}` },
                    h("span", { style: { ...styles.mono, flex: "0 0 auto", opacity: 0.7 } }, item.layer || "-"),
                    h(
                      "span",
                      { style: { ...styles.mono, ...styles.grow, flex: "1 1 auto" } },
                      item.id || "-",
                    ),
                    h(
                      "span",
                      {
                        style: {
                          flex: "0 0 auto",
                          ...(item.op === "error" ? styles.err : styles.dim),
                        },
                      },
                      item.op,
                    ),
                  ),
                ),
            )
          : h("div", { style: { ...styles.dim, fontSize: 11 } }, "暂无变更记录"),
        h(
          "div",
          { style: { marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
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

      const onToggle = useCallback(async () => {
        setBusy(true)
        try {
          await api("toggle", { method: "POST" })
          await refresh()
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        } finally {
          setBusy(false)
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

      const on = !!state && state.enabled !== false
      const activeLayers = state
        ? Object.keys(state.layers || {})
            .filter((id) => state.layers[id])
            .join(" ")
        : ""

      return h(
        "div",
        { style: styles.shell },
        open ? h(Panel, { state, journal, onReload, busy }) : null,
        h(
          "button",
          {
            style: { ...styles.chip, maxWidth: "100%", overflow: "hidden" },
            onClick: () => setOpen((v) => !v),
            title: "dsh-forge 状态",
          },
          h("span", { style: styles.dot(on) }),
          h("span", { style: styles.grow }, on ? `forge ${activeLayers || "—"}` : "forge off"),
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
