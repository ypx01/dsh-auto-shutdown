// dsh-auto-shutdown — Client half.
// 经典外链脚本（不是 ESM）：加载后向浏览器模块表注册一个 factory，无需构建。
// 约定（来自 dsh-client-modules 实测）：id 必须等于包名；factory 无副作用；
// 可见 DOM 只能通过 slot 注册挂进会话标题栏；样式在 apply 里用 ctx.effect 注册并返回清理。
if (typeof window !== "undefined") {
  window.__ModuleLoader__.load({
    id: "dsh-auto-shutdown",
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      var React = require("react");
      var h = React.createElement;

      var API = "/api/auto-shutdown";
      var PLUGIN = "dsh-auto-shutdown";

      /* ------------------------------------------------------------------ i18n */
      var LANG = (function () {
        try {
          var l = (navigator.language || navigator.userLanguage || "en").toLowerCase();
          return l.indexOf("zh") === 0 ? "zh" : "en";
        } catch {
          return "en";
        }
      })();
      var TEXT = {
        zh: {
          off: "自动关机",
          on: "自动关机",
          waiting: "等 {n} 个会话",
          countdown: "{s} 秒后关机",
          pending: "正在关机 {s} 秒",
          armedCount: "共 {n} 个会话开启",
          offHint: "已关闭：任务完成后不做任何事",
          onHint: "已开启：本会话任务全部完成后自动关机",
          countdownHint: "所有目标会话已完成，点此取消本次关机",
          pendingHint: "系统将在 {s} 秒后关机，点此撤销（shutdown /a）",
          unsupported: "仅支持 Windows",
          error: "接口不可用",
          fireFailed: "关机失败",
          fireFailedHint: "上一次下发关机失败了，开关仍保持开启，恢复后会再次尝试。原因：",
        },
        en: {
          off: "Auto power-off",
          on: "Auto power-off",
          waiting: "{n} session(s) busy",
          countdown: "Off in {s}s",
          pending: "Shutting down in {s}s",
          armedCount: "{n} sessions armed",
          offHint: "Off: nothing happens when the work finishes",
          onHint: "On: power off after this session finishes all its work",
          countdownHint: "All armed sessions finished; click to cancel this shutdown",
          pendingHint: "The machine powers off in {s}s; click to abort (shutdown /a)",
          unsupported: "Windows only",
          error: "API unavailable",
          fireFailed: "Shutdown failed",
          fireFailedHint: "The last shutdown attempt failed; the switch stays on and will retry. Reason: ",
        },
      }[LANG];

      function tpl(text, vars) {
        return String(text).replace(/\{(\w+)\}/g, function (_, key) {
          return vars && vars[key] !== undefined ? String(vars[key]) : "";
        });
      }

      /* ----------------------------------------------------------------- css */
      // 只使用 dsh-client-ui-theme 里确实存在的 token，其余都给硬编码 fallback。
      var CSS = [
        ".dshas-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;",
        "border-radius:13px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.32));background:transparent;",
        "color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:18px;cursor:pointer;",
        "white-space:nowrap;transition:background .12s ease,color .12s ease,border-color .12s ease}",
        ".dshas-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary,inherit)}",
        ".dshas-btn:disabled{opacity:.55;cursor:default}",
        ".dshas-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d7cfe);outline-offset:1px}",
        ".dshas-btn[aria-checked='true']{border-color:var(--dsw-alias-brand-primary,#4d7cfe);",
        "color:var(--dsw-alias-brand-primary,#4d7cfe);background:var(--dsw-alias-bg-layer-2,transparent)}",
        ".dshas-btn[data-phase='countdown']{border-color:#c2410c;color:#c2410c}",
        ".dshas-btn[data-phase='pending']{border-color:#b91c1c;color:#fff;background:#b91c1c}",
        ".dshas-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6))}",
        ".dshas-btn[aria-checked='true'] .dshas-dot{background:var(--dsw-alias-brand-primary,#4d7cfe)}",
        ".dshas-btn[data-phase='countdown'] .dshas-dot{background:#c2410c}",
        ".dshas-btn[data-phase='pending'] .dshas-dot{background:#fff}",
        ".dshas-btn[data-error='1']{border-color:#b91c1c;color:#dc2626}",
        ".dshas-btn[data-error='1'] .dshas-dot{background:#dc2626}",
        ".dshas-icon{flex:none;display:block;width:12px;height:12px}",
      ].join("");

      function installStyles() {
        if (typeof document === "undefined") return function () {};
        var existing = document.querySelector('style[data-plugin-css="' + PLUGIN + '"]');
        if (existing && existing.parentNode) {
          existing.dataset.plugin = PLUGIN;
          existing.textContent = CSS;
          return function () {};
        }
        var node = document.createElement("style");
        node.dataset.plugin = PLUGIN;
        node.dataset.pluginCss = PLUGIN;
        node.textContent = CSS;
        document.head.appendChild(node);
        return function () {
          if (node.parentNode) node.parentNode.removeChild(node);
        };
      }

      /* ----------------------------------------------------------------- api */
      function api(path, options) {
        return fetch(API + path, options).then(function (res) {
          return res.json().then(
            function (body) {
              if (!body || body.ok !== true) throw new Error((body && body.error) || "HTTP " + res.status);
              return body.data !== undefined ? body.data : body;
            },
            function () {
              throw new Error("HTTP " + res.status);
            }
          );
        });
      }

      function post(path, payload) {
        return api(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload || {}),
        });
      }

      /* ------------------------------------------------------------- session */
      var runtime = { ctx: null };

      function currentSessionId() {
        try {
          var list = runtime.ctx && runtime.ctx.sessions && runtime.ctx.sessions.list;
          var snap = list && list.getSnapshot ? list.getSnapshot() : null;
          if (snap && typeof snap.current === "string") return snap.current;
        } catch {
          /* ignore */
        }
        return "";
      }

      function sessionIdOfProps(props) {
        if (!props || typeof props !== "object") return "";
        if (typeof props.sessionId === "string") return props.sessionId;
        if (props.session && typeof props.session === "object") {
          if (typeof props.session.id === "string") return props.session.id;
          if (props.session.header && typeof props.session.header.id === "string") return props.session.header.id;
        }
        return "";
      }

      /* ----------------------------------------------------------- component */
      function PowerIcon() {
        return h(
          "svg",
          { className: "dshas-icon", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", focusable: "false" },
          h("path", { d: "M8 1.6v5.2", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" }),
          h("path", { d: "M4.3 4.2a5.3 5.3 0 1 0 7.4 0", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" })
        );
      }

      function AutoShutdownSwitch(props) {
        // slot 的 standardProps 直接给 sessionId（branded string），优先用它。
        var sid = sessionIdOfProps(props) || currentSessionId();
        var sidRef = React.useRef(sid);
        sidRef.current = sid;

        var state = React.useState({ loading: true, data: null, error: null });
        var snap = state[0];
        var setSnap = state[1];
        var pendingState = React.useState(false);
        var inFlight = pendingState[0];
        var setInFlight = pendingState[1];

        function refresh() {
          var target = sidRef.current;
          var query = target ? "?sessionId=" + encodeURIComponent(target) : "";
          api("/state" + query).then(
            function (data) {
              setSnap({ loading: false, data: data, error: null });
            },
            function (err) {
              setSnap({ loading: false, data: null, error: String((err && err.message) || err) });
            }
          );
        }

        React.useEffect(function () {
          refresh();
          var timer = setInterval(refresh, 1000);
          return function () {
            clearInterval(timer);
          };
        }, [sid]);

        function toggle() {
          if (inFlight) return;
          var target = sidRef.current;
          if (!target) return;
          var data = snap.data;
          var armedNow = !!(data && data.viewer && data.viewer.armed);
          var active = !!(data && (data.countdown || data.pending));
          setInFlight(true);
          // 倒计时/已下发阶段点一下 = 取消这次关机（同时关掉本会话的开关）。
          var request = active
            ? post("/cancel", { sessionId: target, reason: "user" })
            : post("/set", { sessionId: target, armed: !armedNow });
          request.then(
            function (result) {
              setInFlight(false);
              var next = result && result.state ? result.state : result;
              if (next && next.armed !== undefined) setSnap({ loading: false, data: next, error: null });
              else refresh();
            },
            function (err) {
              setInFlight(false);
              setSnap({ loading: false, data: snap.data, error: String((err && err.message) || err) });
            }
          );
        }

        var data = snap.data;
        if (data && data.supported === false) {
          return h("button", { className: "dshas-btn", type: "button", disabled: true, title: TEXT.unsupported }, TEXT.unsupported);
        }

        var armed = !!(data && data.viewer && data.viewer.armed);
        var countdownMs = data && data.countdown ? data.countdown.remainingMs : null;
        var pendingMs = data && data.pending ? data.pending.remainingMs : null;
        var seconds = pendingMs !== null ? Math.ceil(pendingMs / 1000) : countdownMs !== null ? Math.ceil(countdownMs / 1000) : 0;
        var phase = pendingMs !== null ? "pending" : countdownMs !== null ? "countdown" : armed ? "armed" : "idle";
        var armedCount = data && data.armed ? data.armed.length : 0;
        var blocking = (data && data.blocking ? data.blocking.length : 0) + (data && data.otherBusy ? data.otherBusy.length : 0);
        var lastError = data && data.lastError && data.lastError.message ? String(data.lastError.message) : null;

        var label;
        if (phase === "pending") label = tpl(TEXT.pending, { s: seconds });
        else if (phase === "countdown") label = tpl(TEXT.countdown, { s: seconds });
        else if (lastError) label = TEXT.fireFailed;
        else if (armed && blocking > 0) label = tpl(TEXT.waiting, { n: blocking });
        else if (armed && armedCount > 1) label = TEXT.on + " · " + tpl(TEXT.armedCount, { n: armedCount });
        else label = TEXT[armed ? "on" : "off"];

        var title;
        if (snap.error) title = TEXT.error + "：" + snap.error;
        else if (lastError) title = TEXT.fireFailedHint + lastError;
        else if (phase === "pending") title = tpl(TEXT.pendingHint, { s: seconds });
        else if (phase === "countdown") title = TEXT.countdownHint;
        else title = (armed ? TEXT.onHint : TEXT.offHint) + (armed && armedCount > 1 ? "\n" + tpl(TEXT.armedCount, { n: armedCount }) : "");

        return h(
          "button",
          {
            className: "dshas-btn",
            type: "button",
            role: "switch",
            "aria-checked": armed ? "true" : "false",
            "aria-label": TEXT.on,
            "data-phase": phase,
            "data-error": lastError ? "1" : "0",
            "data-count": String(armedCount),
            disabled: inFlight || (snap.loading && !data),
            title: title,
            onClick: toggle,
          },
          h(PowerIcon),
          h("span", { className: "dshas-dot" }),
          h("span", null, label)
        );
      }

      /* ---------------------------------------------------------------- apply */
      function apply(ctx) {
        runtime.ctx = ctx;
        ctx.effect(installStyles, PLUGIN + ": styles");
        ctx.slots.inject("conversation.session.header.utilities", function () {
          return ctx.slots.register(
            { name: "conversation.session.header.utilities", id: PLUGIN, order: 30, label: TEXT.on },
            AutoShutdownSwitch
          );
        });
        return function () {
          runtime.ctx = null;
        };
      }

      // 必须在 apply 里用到的 client 服务，缺声明时 cordis ctx 代理会抛错。
      var inject = ["slots", "sessions"];
      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    },
  });
}
