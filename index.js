/**
 * dsh-auto-shutdown — Host half.
 *
 * 每个会话一个「任务完成后自动关机」开关。
 *  - 开关打开：等该会话手上的活全部执行完（默认还要等其它在线会话也空闲），
 *    经过 countdownMs 冷静期后由本进程执行系统关机。
 *  - 开关关闭：什么都不做。
 *  - 多个会话同时打开：必须全部完成才关机。
 *  - 不持久化：进程重启后所有开关都是关的（= 新会话默认关闭）。
 *
 * 判定权威来源：`workspace/session-activity` 瀑布事件。
 * 它是 harness 自己用来「拒绝归档还有活干的会话」的同一判据，已聚合 turn / job /
 * subagent / schedule 四类提供方，返回空数组即「没活干」。比订阅 agent/status 或
 * 自己数子代理都可靠。事件订阅只作为瀑布不可用时的降级路径，并用于即时取消倒计时。
 */
import { spawn as spawnChild } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "auto-shutdown";
export const inject = ["webServer"];

const API = "/api/auto-shutdown";
const ACTIVITY_EVENT = "workspace/session-activity";
const SHUTDOWN_EXE = "C:\\Windows\\System32\\shutdown.exe";
const CMD_EXE = "C:\\Windows\\System32\\cmd.exe";
const SHUTDOWN_COMMENT = "DSH 自动关机：已开启开关的会话全部完成";

const DEFAULTS = {
  countdownMs: 120000,
  shutdownGraceSeconds: 20,
  requireGlobalQuiet: true,
  force: true,
  dryRun: false,
  ignoreKinds: [],
  debug: false,
};

/* ------------------------------------------------------------------ utils */

function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function makeLog(cfg) {
  // `logFile: null` 关闭落盘（单测用，避免把测试事件写进真实排障日志）。
  const file =
    cfg.logFile === null ? null : cfg.logFile || join(resolveDshHome(), "auto-shutdown.log");
  return (event, detail) => {
    if (cfg.debug) {
      try {
        console.log(`[auto-shutdown] ${event} ${detail ? JSON.stringify(detail) : ""}`);
      } catch {
        /* ignore */
      }
    }
    if (!file) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), event, detail: detail ?? null }) + "\n";
    appendFile(file, line, "utf8").catch(() => {});
  };
}

function clampInt(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeConfig(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const bool = (v, d) => (typeof v === "boolean" ? v : d);
  const kinds = Array.isArray(c.ignoreKinds) ? c.ignoreKinds.filter((k) => typeof k === "string") : DEFAULTS.ignoreKinds;
  return {
    countdownMs: clampInt(c.countdownMs, DEFAULTS.countdownMs, 1000, 3600000),
    shutdownGraceSeconds: clampInt(c.shutdownGraceSeconds, DEFAULTS.shutdownGraceSeconds, 0, 600),
    requireGlobalQuiet: bool(c.requireGlobalQuiet, DEFAULTS.requireGlobalQuiet),
    force: bool(c.force, DEFAULTS.force),
    dryRun: bool(c.dryRun, DEFAULTS.dryRun),
    ignoreKinds: kinds,
    debug: bool(c.debug, DEFAULTS.debug),
    logFile:
      c.logFile === null
        ? null
        : typeof c.logFile === "string" && c.logFile.trim()
          ? c.logFile.trim()
          : undefined,
  };
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 1 << 18) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

function sessionIdOf(session) {
  if (!session) return null;
  const id = session.id ?? session.sessionId ?? session.header?.id;
  return typeof id === "string" ? id : null;
}

function labelOf(session) {
  if (!session) return "";
  const header = session.header ?? {};
  const title = header.title ?? header.name ?? session.title;
  if (typeof title === "string" && title.trim() !== "") return title.trim();
  const cwd = header.cwd ?? session.cwd;
  if (typeof cwd === "string" && cwd.trim() !== "") {
    const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : cwd;
  }
  const id = sessionIdOf(session);
  return id ? id.slice(0, 8) : "";
}

function isSubagentSession(session) {
  const origin = session?.header?.origin ?? session?.origin;
  return origin === "subagent";
}

function every(ctx, fn, ms) {
  try {
    if (typeof ctx?.setInterval === "function") return ctx.setInterval(fn, ms);
  } catch {
    /* 没有 timer 服务时退回全局定时器 */
  }
  const handle = setInterval(fn, ms);
  if (handle && typeof handle.unref === "function") handle.unref();
  return () => clearInterval(handle);
}

/* ------------------------------------------------------------------- core */

function createCore(ctx, cfg, log) {
  /** armedId -> { armedAt, label } */
  const armed = new Map();
  /** 事件降级路径的忙闲表：sessionId -> { busy, lastActivityAt, phase } */
  const tracked = new Map();
  /** { startedAt, deadline } | null */
  let countdown = null;
  /** { at, until } | null —— 已经下发 shutdown /t N */
  let pending = null;
  let lastFired = null;
  /** { at, message } | null —— 最近一次下发关机的失败原因（成功后清空） */
  let lastFireError = null;
  let ticker = null;
  let tickBusy = false;
  let waterfallWarned = false;

  const now = () => Date.now();
  const isWindows = process.platform === "win32";
  const subprocess = () => {
    try {
      return ctx.get("subprocess") ?? null;
    } catch {
      return null;
    }
  };

  function touch(id, busy, phase) {
    if (!id) return;
    const prev = tracked.get(id) ?? { busy: false, lastActivityAt: 0 };
    tracked.set(id, {
      busy: typeof busy === "boolean" ? busy : prev.busy,
      lastActivityAt: now(),
      phase: phase ?? prev.phase,
    });
  }

  function liveSessions() {
    try {
      const list = ctx.get("sessions")?.list?.();
      if (Array.isArray(list)) return list;
      if (list && typeof list.values === "function") return [...list.values()];
      return [];
    } catch {
      return [];
    }
  }

  /** 问 harness：这个会话还有活干吗？返回 { busy, kinds }。 */
  async function hasWork(sessionId, liveSessionsById) {
    if (typeof ctx.waterfall === "function") {
      try {
        const activities = await ctx.waterfall(ACTIVITY_EVENT, { sessionId }, () => Promise.resolve([]));
        if (Array.isArray(activities)) {
          const kinds = activities.map((a) => (a && typeof a.kind === "string" ? a.kind : "unknown"));
          const blocking = kinds.filter((k) => cfg.ignoreKinds.indexOf(k) < 0);
          return { busy: blocking.length > 0, kinds, source: "waterfall" };
        }
      } catch (e) {
        if (!waterfallWarned) {
          waterfallWarned = true;
          log("waterfall-failed", { message: String(e?.message ?? e) });
        }
      }
    }
    const entry = tracked.get(sessionId);
    return { busy: entry ? entry.busy : false, kinds: entry ? [entry.phase ?? "tracked"] : [], source: "events" };
  }

  /** 全量判定：哪些会话还忙、是否满足关机条件。 */
  async function judge() {
    const live = liveSessions();
    const liveById = new Map();
    for (const session of live) {
      const id = sessionIdOf(session);
      if (id) liveById.set(id, session);
    }

    const targets = new Set(liveById.keys());
    for (const id of armed.keys()) targets.add(id);

    const work = new Map();
    await Promise.all(
      [...targets].map(async (id) => {
        if (!liveById.has(id)) {
          work.set(id, { busy: false, kinds: [], live: false, label: armed.get(id)?.label ?? "" });
          return;
        }
        const result = await hasWork(id);
        const session = liveById.get(id);
        work.set(id, { ...result, live: true, label: labelOf(session), subagent: isSubagentSession(session) });
      })
    );

    const armedStates = [...armed.entries()].map(([id, entry]) => {
      const w = work.get(id) ?? { busy: false, kinds: [], live: false };
      return {
        sessionId: id,
        label: entry.label,
        armedAt: entry.armedAt,
        live: !!w.live,
        busy: !!w.busy,
        kinds: w.kinds ?? [],
      };
    });

    const blockingArmed = armedStates.filter((s) => s.busy);
    const otherBusy = [];
    if (cfg.requireGlobalQuiet) {
      for (const [id, w] of work) {
        if (armed.has(id)) continue;
        if (!w.live || !w.busy) continue;
        otherBusy.push({ sessionId: id, label: w.label ?? "", kinds: w.kinds ?? [], subagent: !!w.subagent });
      }
    }

    const quiet = armed.size > 0 && blockingArmed.length === 0 && otherBusy.length === 0;
    return { quiet, armedStates, blockingArmed, otherBusy };
  }

  function cancelCountdown(reason) {
    if (countdown !== null) {
      log("countdown-cancel", { reason, startedAt: countdown.startedAt });
      countdown = null;
    }
  }

  function startCountdown() {
    countdown = { startedAt: now(), deadline: now() + cfg.countdownMs };
    log("countdown-start", { deadline: countdown.deadline, countdownMs: cfg.countdownMs });
  }

  /** 用与 fire() 相同的 spec 形状起一个子进程，并等它的 exit 事实（诊断用）。 */
  async function spawnProbe(argv, waitMs = 15000) {
    const spec = {
      argv,
      cwd: homedir(),
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      graceMs: 5000,
    };
    const startedAt = now();
    const sp = subprocess();
    if (!sp || typeof sp.spawn !== "function") return { ok: false, argv, error: "ctx.subprocess unavailable" };
    try {
      const handle = sp.spawn(spec);
      const settled = await Promise.race([
        Promise.resolve(handle?.done).then(
          (r) => ({ exit: { exitCode: r?.exitCode ?? null, signal: r?.signal ?? null } }),
          (e) => ({ error: String(e?.message ?? e) })
        ),
        new Promise((r) => setTimeout(() => r({ timeout: true }), waitMs)),
      ]);
      return { ok: true, argv, ms: now() - startedAt, ...settled };
    } catch (e) {
      return { ok: false, argv, ms: now() - startedAt, error: String(e?.message ?? e) };
    }
  }

  function fire() {
    countdown = null;
    const seconds = cfg.shutdownGraceSeconds;
    const argv = [SHUTDOWN_EXE, "/s"];
    if (cfg.force) argv.push("/f");
    argv.push("/t", String(seconds));
    argv.push("/c", SHUTDOWN_COMMENT);

    const sessions = [...armed.keys()];

    if (!isWindows) {
      log("fire-unsupported", { platform: process.platform });
      return;
    }
    if (cfg.dryRun) {
      lastFired = { at: now(), argv, dryRun: true, seconds, sessions };
      armed.clear();
      log("fire-dry-run", { argv });
      return;
    }

    // harness 的 ctx.subprocess.spawn 会对 spec.cwd 做 null-byte 校验
    // （validateNoNullByte → `value.includes("\0")`），cwd 缺省即 TypeError。
    const spec = {
      argv,
      cwd: homedir(),
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      graceMs: 5000,
    };
    try {
      const sp = subprocess();
      if (sp && typeof sp.spawn === "function") {
        const handle = sp.spawn(spec);
        handle?.done?.then?.(() => {}).catch?.(() => {});
      } else {
        const child = spawnChild("shutdown.exe", argv.slice(1), {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          cwd: homedir(),
        });
        child.unref();
      }
      // 只有真正下发成功后，才清空开关表并进入 pending（红色倒计时）：
      // 下发失败则保留开关，让 UI 继续显示「已开启」+ 失败原因，绝不静默丢失。
      lastFired = { at: now(), argv, dryRun: false, seconds, sessions };
      lastFireError = null;
      armed.clear();
      countdown = null;
      pending = { at: now(), until: now() + seconds * 1000 };
      log("fire", { argv, seconds });
    } catch (e) {
      const message = String(e?.message ?? e);
      lastFireError = { at: now(), message };
      cancelCountdown("fire-error");
      log("fire-throw", { message, cwd: spec.cwd });
    }
  }

  /** 推进一格：静则起倒计时，动则取消；到点再核一次才真发关机。 */
  async function tick() {
    if (tickBusy) return;
    tickBusy = true;
    try {
      if (armed.size === 0) {
        cancelCountdown("no-armed");
        return;
      }
      if (pending !== null && now() >= pending.until) pending = null;
      const verdict = await judge();
      if (!verdict.quiet) {
        cancelCountdown(verdict.blockingArmed.length ? "armed-session-busy" : "other-session-busy");
        return;
      }
      if (countdown === null && pending === null) startCountdown();
      if (countdown !== null && now() >= countdown.deadline) fire();
    } finally {
      tickBusy = false;
    }
  }

  /** 取消这次关机：点「取消」的会话同时关掉自己的开关，否则下一格 tick 又会重新起倒计时。 */
  async function cancel(reason, sessionId) {
    if (typeof sessionId === "string" && sessionId !== "" && armed.delete(sessionId)) {
      log("disarm-on-cancel", { sessionId, reason });
    }
    cancelCountdown(reason);
    if (pending === null) return false;
    pending = null;
    if (isWindows && !cfg.dryRun) {
      const spec = {
        argv: [SHUTDOWN_EXE, "/a"],
        cwd: homedir(),
        stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        graceMs: 5000,
      };
      try {
        const sp = subprocess();
        if (sp && typeof sp.spawn === "function") sp.spawn(spec);
        else spawnChild("shutdown.exe", ["/a"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
        log("abort-os-shutdown", { reason });
      } catch (e) {
        log("abort-os-shutdown-error", { message: String(e?.message ?? e) });
      }
    }
    return true;
  }

  async function snapshot(viewerSessionId) {
    const verdict = await judge();
    return {
      supported: isWindows,
      platform: process.platform,
      config: {
        countdownMs: cfg.countdownMs,
        shutdownGraceSeconds: cfg.shutdownGraceSeconds,
        requireGlobalQuiet: cfg.requireGlobalQuiet,
        force: cfg.force,
        dryRun: cfg.dryRun,
      },
      viewer: viewerSessionId
        ? {
            sessionId: viewerSessionId,
            armed: armed.has(viewerSessionId),
            busy: (verdict.armedStates.find((s) => s.sessionId === viewerSessionId)?.busy ?? false) || false,
          }
        : null,
      armed: verdict.armedStates.map((s) => ({
        sessionId: s.sessionId,
        label: s.label,
        armedAt: s.armedAt,
        busy: s.busy,
        live: s.live,
        kinds: s.kinds,
      })),
      quiet: verdict.quiet,
      blocking: verdict.blockingArmed.map((s) => ({ sessionId: s.sessionId, label: s.label, kinds: s.kinds })),
      otherBusy: verdict.otherBusy,
      countdown:
        countdown === null
          ? null
          : { deadline: countdown.deadline, remainingMs: Math.max(0, countdown.deadline - now()) },
      pending: pending === null ? null : { until: pending.until, remainingMs: Math.max(0, pending.until - now()) },
      lastFired,
      lastError: lastFireError,
    };
  }

  async function setArmed(sessionId, nextArmed, session) {
    if (typeof sessionId !== "string" || sessionId === "") return { ok: false, error: "missing sessionId" };
    if (!isWindows) return { ok: false, error: `本插件仅支持 Windows（当前平台 ${process.platform}）` };
    if (nextArmed) {
      if (!armed.has(sessionId)) {
        armed.set(sessionId, { armedAt: now(), label: labelOf(session) });
        log("arm", { sessionId, label: armed.get(sessionId).label });
      }
      touch(sessionId, undefined, "armed");
      if (pending !== null) await cancel("re-armed");
    } else if (armed.delete(sessionId)) {
      log("disarm", { sessionId });
      if (armed.size === 0) await cancel("last-disarmed");
      else if (pending !== null) await cancel("disarmed");
    }
    await tick();
    return { ok: true, data: await snapshot(sessionId) };
  }

  /* -------------------------------------------------------------- events */

  // 降级路径 + 即时取消：会话任何事件都算「刚才有活动」。
  ctx.on("session/event", (session, event) => {
    const id = sessionIdOf(session);
    if (!id) return;
    const type = event?.type;
    const data = event?.data ?? {};
    let busy;
    if (typeof data.phase === "string") busy = !(data.phase === "done" || data.phase === "idle");
    else if (type === "turn/end") busy = false;
    else if (type === "turn/start") busy = true;
    touch(id, busy, typeof data.phase === "string" ? data.phase : type);
    if (busy === true) cancelCountdown(`session-event:${type ?? "unknown"}`);
  });

  ctx.on("api-session/status", (sessionId, running) => {
    if (typeof sessionId !== "string") return;
    touch(sessionId, running === true, "api-session/status");
    if (running === true) cancelCountdown("api-session-busy");
  });

  ctx.on("session/disposed", (session) => {
    const id = sessionIdOf(session);
    if (!id) return;
    tracked.delete(id);
    if (armed.delete(id)) {
      log("disarm-disposed", { sessionId: id });
      if (armed.size === 0) void cancel("last-disarmed");
    }
  });

  ticker = every(
    ctx,
    () => {
      void tick().catch((e) => log("tick-error", { message: String(e?.message ?? e) }));
    },
    1000
  );

  return {
    isWindows,
    setArmed,
    snapshot,
    cancel,
    listSessions: liveSessions,
    /**
     * 诊断：用与 fire() 完全相同的 spec 形状真起一个子进程，证明下发链路可用。
     * - 默认只跑 `cmd /c exit 7`（无害，验证 spec/服务/exit 事实）；
     * - realShutdown=true 时额外真下发 `shutdown /s /t 6000` 并立刻 `/a` 撤销
     *   （100 分钟窗口，正常 2 秒内撤销，用来证明 shutdown.exe 这条路真的通）。
     */
    async selfTest(realShutdown) {
      const steps = [];
      steps.push({ name: "spawn-smoke", ...(await spawnProbe([CMD_EXE, "/c", "exit", "7"])) });
      if (realShutdown) {
        steps.push({
          name: "arm-remote-shutdown",
          ...(await spawnProbe([SHUTDOWN_EXE, "/s", "/t", "6000", "/c", "dsh-auto-shutdown self-test"])),
        });
        await new Promise((r) => setTimeout(r, 1500));
        steps.push({ name: "abort-remote-shutdown", ...(await spawnProbe([SHUTDOWN_EXE, "/a"])) });
      }
      return { platform: process.platform, cwd: homedir(), steps };
    },
    async probe() {
      const verdict = await judge();
      return {
        wouldShutdown: verdict.quiet,
        ...verdict,
        stats: {
          ...state.stats,
          clientAlive: state.stats.stateRequests > 0 && now() - state.stats.lastStateAt < 15000,
        },
        countdown:
          countdown === null ? null : { deadline: countdown.deadline, remainingMs: Math.max(0, countdown.deadline - now()) },
        pending,
        lastFired,
        lastError: lastFireError,
      };
    },
    dispose() {
      try {
        ticker?.();
      } catch {
        /* ignore */
      }
      countdown = null;
      if (pending !== null) void cancel("plugin-disposed");
    },
  };
}

/* ------------------------------------------------------------------- apply */

/**
 * 进程级状态。为什么要放在模块外：
 * 卸载插件时 cordis 只执行 `ctx.effect` 注册的清理函数（`apply` 的返回值不算），
 * 所以热重载后旧路由可能还留在 webServer 里。把「当前 core」放进进程级 state，
 * 并让路由 handler 始终按 state 派发，旧路由就会自动指向新 core 而不是变成僵尸。
 */
const state = {
  core: null,
  routeRegistered: false,
  stats: { stateRequests: 0, lastStateAt: 0, setRequests: 0 },
};

async function dispatch(req, res) {
  const core = state.core;
  if (core === null) {
    json(res, 503, { ok: false, error: "auto-shutdown plugin is not active" });
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname.replace(/\/+$/, "");
  try {
    if (req.method === "GET" && path === `${API}/state`) {
      state.stats.stateRequests += 1;
      state.stats.lastStateAt = Date.now();
      json(res, 200, { ok: true, data: await core.snapshot(url.searchParams.get("sessionId") || null) });
      return;
    }
    if (req.method === "GET" && path === `${API}/probe`) {
      json(res, 200, { ok: true, data: await core.probe() });
      return;
    }
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: `method not allowed: ${req.method}` });
      return;
    }
    const body = await readBody(req);
    if (path === `${API}/self-test`) {
      const report = await core.selfTest(body.realShutdown === true);
      json(res, 200, { ok: true, data: report });
      return;
    }
    if (path === `${API}/set`) {
      state.stats.setRequests += 1;
      const sessionId = String(body.sessionId ?? "");
      const session = (() => {
        try {
          const list = core.listSessions();
          return list.find((s) => sessionIdOf(s) === sessionId);
        } catch {
          return undefined;
        }
      })();
      const result = await core.setArmed(sessionId, body.armed === true, session);
      json(res, result.ok === false ? 400 : 200, result);
      return;
    }
    if (path === `${API}/cancel`) {
      const sessionId = String(body.sessionId ?? "");
      const aborted = await core.cancel(String(body.reason ?? "user"), sessionId || undefined);
      json(res, 200, {
        ok: true,
        data: { aborted, state: await core.snapshot(sessionId || null) },
      });
      return;
    }
    json(res, 404, { ok: false, error: `unknown action: ${path}` });
  } catch (e) {
    try {
      json(res, 500, { ok: false, error: String(e?.message ?? e) });
    } catch {
      /* response already closed */
    }
  }
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const log = makeLog(cfg);
  const core = createCore(ctx, cfg, log);
  state.core = core;

  let disposer = null;
  try {
    disposer = ctx.webServer.register({ kind: "prefix", path: API, handler: dispatch });
    state.routeRegistered = true;
  } catch (e) {
    const message = String(e?.message ?? e);
    if (message.includes("duplicate prefix route")) {
      // 热重载时旧实例的路由可能还在（它的 handler 也是 dispatch，会指向新 core），复用即可。
      log("route-reuse", { message });
    } else {
      log("route-register-error", { message });
      throw e;
    }
  }

  const dispose = () => {
    if (state.core === core) state.core = null;
    core.dispose();
    try {
      disposer?.();
    } catch {
      /* ignore */
    }
    state.routeRegistered = false;
  };
  if (typeof ctx.effect === "function") ctx.effect(() => dispose);

  log("plugin-ready", {
    countdownMs: cfg.countdownMs,
    requireGlobalQuiet: cfg.requireGlobalQuiet,
    dryRun: cfg.dryRun,
    routeShared: state.routeRegistered,
  });

  return dispose;
}

