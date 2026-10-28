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

    /**
     * iOS 风格开关（Apple HIG 的 UISwitch 观感）：
     * 轨道 32×18 / 圆角 9；旋钮 14，开启时在右。关闭轨道用系统级 32% 灰。
     *
     * 这个开关就是本插件唯一的界面 —— 既是状态显示，也是控制手段。
     */
    const styles = {
      wrap: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        flex: "0 0 auto",
        userSelect: "none",
      },
      label: { fontSize: 11, lineHeight: "18px", opacity: 0.55, letterSpacing: ".02em" },
      track: (on) => ({
        position: "relative",
        width: 32,
        height: 18,
        flex: "0 0 auto",
        borderRadius: 9,
        border: "none",
        padding: 0,
        margin: 0,
        cursor: "pointer",
        background: on ? "#34c759" : "rgba(120,120,128,.32)",
        transition: "background-color .2s ease",
        WebkitTapHighlightColor: "transparent",
      }),
      trackBusy: { opacity: 0.55, cursor: "default" },
      knob: (on) => ({
        position: "absolute",
        top: 2,
        left: on ? 16 : 2,
        width: 14,
        height: 14,
        borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 2px rgba(0,0,0,.28), 0 0 0 .5px rgba(0,0,0,.04)",
        transition: "left .2s cubic-bezier(.32,.72,0,1)",
        pointerEvents: "none",
      }),
    }

    function ForgeSwitch() {
      // null = 还没读到状态，先不渲染，避免闪一个错的状态
      const [on, setOn] = useState(null)
      const [busy, setBusy] = useState(false)
      const alive = useRef(true)

      const refresh = useCallback(async () => {
        try {
          const state = await api("state")
          if (alive.current) setOn(state.enabled !== false)
        } catch {
          /* 读不到就保持上一次的状态，别把开关画成关 */
        }
      }, [])

      useEffect(() => {
        alive.current = true
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [refresh])

      const toggle = useCallback(async () => {
        if (busy) return
        setBusy(true)
        try {
          const next = await api("toggle", { method: "POST" })
          if (alive.current) setOn(next.enabled !== false)
        } catch {
          /* 失败保持原样 */
        } finally {
          if (alive.current) setBusy(false)
        }
      }, [busy])

      if (on === null) return null

      const title = on ? "dsh-forge：已开启（点击关闭）" : "dsh-forge：已关闭（点击开启）"
      return h(
        "span",
        { style: styles.wrap, title },
        h("span", { style: styles.label }, "forge"),
        h(
          "button",
          {
            type: "button",
            role: "switch",
            "aria-checked": on ? "true" : "false",
            "aria-label": "dsh-forge",
            title,
            style: { ...styles.track(on), ...(busy ? styles.trackBusy : null) },
            onClick: toggle,
            onMouseDown: (event) => event.preventDefault(),
          },
          h("span", { style: styles.knob(on) }),
        ),
      )
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        /**
         * conversation.input.left 渲染在 InputBar 的 .uV2eYG_row 里，
         * 紧跟 .modes（权限下拉）之后、.trailing 之前 ——
         * 与「+」和权限下拉同一行，就是这里。
         */
        ctx.slots.inject("conversation.input.left", () =>
          ctx.slots.register(
            {
              name: "conversation.input.left",
              id: "dsh-forge-switch",
              order: 10,
            },
            ForgeSwitch,
          ),
        )
      },
    }
  },
})
