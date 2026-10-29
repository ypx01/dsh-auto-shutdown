/**
 * Host 侧状态机测试（无第三方依赖）。
 *
 * 用假 ctx 驱动真实的 apply()：
 *  - 不接触真实会话、不真的关机（dryRun + logFile:null）
 *  - 瀑布、事件、定时器都由 fixture 提供，可精确控制「谁还在干活」
 *
 * 跑：node test/state-machine.test.mjs
 */
import assert from "node:assert/strict";
import { apply } from "../index.js";

/* --------------------------------------------------------------- fixtures */

const API = "/api/auto-shutdown";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeHarness() {
  const timers = [];
  const handlers = new Map();
    const state = {
    liveSessions: [],
    /** sessionId -> SessionActivity[] */
    activities: new Map(),
    waterfallThrows: false,
    route: null,
    cleanups: [],
    spawned: [],
    spawnFails: false,
  };

  const ctx = {
    on(type, fn) {
      const list = handlers.get(type) ?? [];
      list.push(fn);
      handlers.set(type, list);
    },
    get(name) {
      if (name === "sessions") return { list: () => state.liveSessions };
      if (name === "subprocess")
        return {
          spawn(spec) {
            // 复刻 harness 的真实行为：validateNoNullByte("options.cwd", spec.cwd)
            // 对 undefined 调用 .includes → TypeError。
            if (spec.cwd === undefined) throw new TypeError("Cannot read properties of undefined (reading 'includes')");
            if (state.spawnFails) throw new TypeError("Cannot read properties of undefined (reading 'includes')");
            state.spawned.push(spec);
            return { done: Promise.resolve({ exitCode: 0, signal: null }) };
          },
        };
      return undefined;
    },
    async waterfall(type, payload) {
      if (state.waterfallThrows) throw new Error("no provider for " + type);
      return state.activities.get(payload.sessionId) ?? [];
    },
    // 真实 harness 的 ctx.setInterval 返回 disposer（不是 handle）
    setInterval(fn) {
      timers.push(fn);
      return () => {
        const i = timers.indexOf(fn);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    webServer: {
      register(route) {
        state.route = route;
        return () => {
          state.route = null;
        };
      },
    },
    effect(fn) {
      const cleanup = fn();
      state.cleanups.push(cleanup);
      return cleanup;
    },
  };

  const harness = {
    ctx,
    state,
    emit(type, ...args) {
      for (const fn of handlers.get(type) ?? []) fn(...args);
    },
    async tick() {
      for (const fn of [...timers]) await fn();
    },
    session(id, title) {
      return { id, header: { title } };
    },
    async callWith(handler, { method = "GET", path, body } = {}) {
      const res = {
        status: 0,
        headers: null,
        text: "",
        writeHead(code, headers) {
          this.status = code;
          this.headers = headers;
        },
        end(text) {
          this.text = text ?? "";
        },
      };
      const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
      const req = {
        method,
        url: path,
        on(event, fn) {
          if (event === "data") for (const chunk of payload) fn(chunk);
          if (event === "end") fn();
          return req;
        },
        destroy() {},
      };
      await handler(req, res);
      let parsed = null;
      try {
        parsed = res.text ? JSON.parse(res.text) : null;
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed };
    },
    call(opts) {
      return harness.callWith(state.route.handler, opts);
    },
    get(path) {
      return harness.call({ method: "GET", path: API + path });
    },
    post(path, body) {
      return harness.call({ method: "POST", path: API + path, body });
    },
  };

  return harness;
}

const CONFIG = {
  countdownMs: 1000,
  shutdownGraceSeconds: 20,
  requireGlobalQuiet: true,
  force: true,
  dryRun: true,
  ignoreKinds: [],
  debug: false,
  logFile: null,
};

/* ----------------------------------------------------------------- runner */

const results = [];

async function check(title, fn) {
  try {
    await fn();
    results.push({ ok: true, title });
    console.log(`  ok   ${title}`);
  } catch (e) {
    results.push({ ok: false, title, error: e });
    console.log(`  FAIL ${title}`);
    console.log(`       ${String(e?.message ?? e).split("\n").join("\n       ")}`);
  }
}

/** 起一个干净实例：live 会话 + 各自的瀑布结果。 */
function setup({ sessions = [["s1", "会话 s1"]], busy = {}, config = {} } = {}) {
  const h = makeHarness();
  h.state.liveSessions = sessions.map(([id, title]) => h.session(id, title));
  for (const [id, kinds] of Object.entries(busy)) {
    h.state.activities.set(id, kinds.map((kind) => ({ kind })));
  }
  const dispose = apply(h.ctx, { ...CONFIG, ...config });
  return { h, dispose };
}

/* ------------------------------------------------------------------ tests */

console.log("dsh-auto-shutdown / host state machine");

await check("新会话默认关闭：没有 arm 时 viewer.armed=false", async () => {
  const { h, dispose } = setup();
  const { status, body } = await h.get("/state?sessionId=s1");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.viewer.armed, false);
  assert.deepEqual(body.data.armed, []);
  assert.equal(body.data.countdown, null);
  dispose();
});

await check("打开开关但会话仍在跑：不进入倒计时", async () => {
  const { h, dispose } = setup({ busy: { s1: ["turn"] } });
  const { status, body } = await h.post("/set", { sessionId: "s1", armed: true });
  assert.equal(status, 200);
  assert.equal(body.data.viewer.armed, true);
  assert.equal(body.data.quiet, false);
  assert.equal(body.data.countdown, null);
  assert.ok(body.data.blocking.length >= 1, "应列出还在忙的开关会话");
  dispose();
});

await check("单个会话：空闲后倒计时 → 到点下发关机（dryRun）", async () => {
  const { h, dispose } = setup();
  await h.post("/set", { sessionId: "s1", armed: true });
  let probe = await h.get("/probe");
  assert.ok(probe.body.data.countdown, "空闲后应立即开始倒计时");
  await sleep(1050);
  await h.tick();
  probe = await h.get("/probe");
  assert.equal(probe.body.data.lastFired.dryRun, true);
  assert.equal(probe.body.data.countdown, null);
  assert.deepEqual(probe.body.data.lastFired.sessions, ["s1"]);
  assert.deepEqual(probe.body.data.armedStates, [], "关机下发后开关表应清空");
  dispose();
});

await check("多个会话同时开：全部空闲才关机，一次带走所有开关", async () => {
  const { h, dispose } = setup({ sessions: [["s1", "一"], ["s2", "二"]] });
  await h.post("/set", { sessionId: "s1", armed: true });
  const second = await h.post("/set", { sessionId: "s2", armed: true });
  assert.equal(second.body.data.armed.length, 2);
  assert.equal(second.body.data.quiet, true);
  await sleep(1050);
  await h.tick();
  const probe = await h.get("/probe");
  assert.deepEqual(probe.body.data.lastFired.sessions.sort(), ["s1", "s2"]);
  dispose();
});

await check("多个会话只开了一个：另一个还在跑就不关机", async () => {
  const { h, dispose } = setup({
    sessions: [["s1", "一"], ["s2", "二"]],
    busy: { s2: ["turn", "job"] },
  });
  const { body } = await h.post("/set", { sessionId: "s1", armed: true });
  assert.equal(body.data.quiet, false);
  assert.equal(body.data.countdown, null);
  assert.deepEqual(body.data.otherBusy.map((x) => x.sessionId), ["s2"]);
  dispose();
});

await check("多个会话都开了，但其中一个还在跑：全部完成前不关机", async () => {
  const { h, dispose } = setup({
    sessions: [["s1", "一"], ["s2", "二"]],
    busy: { s2: ["subagent"] },
  });
  await h.post("/set", { sessionId: "s1", armed: true });
  const { body } = await h.post("/set", { sessionId: "s2", armed: true });
  assert.equal(body.data.quiet, false);
  assert.equal(body.data.countdown, null);
  assert.deepEqual(body.data.blocking.map((x) => x.sessionId), ["s2"]);
  h.state.activities.delete("s2");
  await h.tick();
  const probe = await h.get("/probe");
  assert.ok(probe.body.data.countdown, "全部空闲后应开始倒计时");
  dispose();
});

await check("requireGlobalQuiet:false 时，不关心没开开关的会话", async () => {
  const { h, dispose } = setup({
    sessions: [["s1", "一"], ["s2", "二"]],
    busy: { s2: ["turn"] },
    config: { requireGlobalQuiet: false },
  });
  const { body } = await h.post("/set", { sessionId: "s1", armed: true });
  assert.deepEqual(body.data.otherBusy, []);
  assert.equal(body.data.quiet, true);
  assert.ok(body.data.countdown);
  dispose();
});

await check("关掉开关：倒计时取消且不再有任何动作", async () => {
  const { h, dispose } = setup();
  await h.post("/set", { sessionId: "s1", armed: true });
  const off = await h.post("/set", { sessionId: "s1", armed: false });
  assert.equal(off.body.data.viewer.armed, false);
  assert.equal(off.body.data.countdown, null);
  await sleep(1050);
  await h.tick();
  const probe = await h.get("/probe");
  assert.equal(probe.body.data.lastFired, null, "开关已关，绝不能关机");
  dispose();
});

await check("取消接口：关掉该会话开关并中止倒计时", async () => {
  const { h, dispose } = setup();
  await h.post("/set", { sessionId: "s1", armed: true });
  const { status, body } = await h.post("/cancel", { sessionId: "s1", reason: "user" });
  assert.equal(status, 200);
  assert.equal(body.data.state.viewer.armed, false);
  assert.equal(body.data.state.countdown, null);
  dispose();
});

await check("瀑布不可用时降级到事件：streaming 算忙，done 才算空闲", async () => {
  const { h, dispose } = setup();
  h.state.waterfallThrows = true;
  h.emit("session/event", { id: "s1" }, { type: "activity/status", data: { phase: "streaming" } });
  const armed = await h.post("/set", { sessionId: "s1", armed: true });
  assert.equal(armed.body.data.quiet, false);
  assert.equal(armed.body.data.countdown, null);
  h.emit("session/event", { id: "s1" }, { type: "activity/status", data: { phase: "done" } });
  await h.tick();
  const probe = await h.get("/probe");
  assert.ok(probe.body.data.countdown, "事件说 done 之后应开始倒计时");
  dispose();
});

await check("ignoreKinds：被排除的活动类型不再阻止关机", async () => {
  const { h, dispose } = setup({ busy: { s1: ["job"] }, config: { ignoreKinds: ["job"] } });
  const { body } = await h.post("/set", { sessionId: "s1", armed: true });
  assert.equal(body.data.quiet, true);
  assert.ok(body.data.countdown);
  dispose();
});

await check("ignoreKinds：待触发的提醒（schedule）不再拖住倒计时", async () => {
  // 回归 2026-10-29 实测的 39.7 秒空窗：回合已结束，但会话里还挂着一枚未到点的提醒，
  // harness 的 session-activity 仍报 schedule，默认配置要等到提醒触发才肯开始倒计时。
  const stuck = setup({ busy: { s1: ["schedule"] } });
  const before = await stuck.h.post("/set", { sessionId: "s1", armed: true });
  assert.equal(before.body.data.quiet, false, "未配置 ignoreKinds 时提醒应阻塞");
  assert.equal(before.body.data.countdown, null);
  stuck.dispose();

  const fixed = setup({ busy: { s1: ["schedule"] }, config: { ignoreKinds: ["schedule"] } });
  const after = await fixed.h.post("/set", { sessionId: "s1", armed: true });
  assert.equal(after.body.data.quiet, true, "ignoreKinds 含 schedule 后应立即空闲");
  assert.ok(after.body.data.countdown, "应立即进入倒计时");
  fixed.dispose();
});

await check("会话在别处被关掉：开关随之移除", async () => {
  const { h, dispose } = setup();
  await h.post("/set", { sessionId: "s1", armed: true });
  h.emit("session/disposed", { id: "s1" });
  const probe = await h.get("/probe");
  assert.deepEqual(probe.body.data.armedStates, []);
  dispose();
});

await check("接口健壮性：缺 sessionId → 400，未知动作 → 404，/state 计入 clientAlive", async () => {
  const { h, dispose } = setup();
  const bad = await h.post("/set", { armed: true });
  assert.equal(bad.status, 400);
  const unknown = await h.call({ method: "POST", path: API + "/nope", body: {} });
  assert.equal(unknown.status, 404);
  const before = (await h.get("/probe")).body.data.stats.stateRequests;
  await h.get("/state?sessionId=s1");
  const probe = await h.get("/probe");
  assert.equal(probe.body.data.stats.stateRequests, before + 1);
  assert.equal(probe.body.data.stats.clientAlive, true);
  dispose();
});

await check("卸载会清掉定时器与开关，旧路由只剩「未激活」兜底", async () => {
  const { h, dispose } = setup();
  await h.post("/set", { sessionId: "s1", armed: true });
  const staleHandler = h.state.route.handler; // 模拟热重载后残留的旧路由
  dispose();
  assert.equal(h.state.cleanups.length, 1);
  assert.equal(h.state.route, null, "webServer 的 disposer 应移除路由");
  await sleep(60);
  await h.tick(); // 定时器已移除，不应有任何事发生
  assert.equal(h.state.spawned.length, 0, "卸载后不得下发关机");
  const stale = await h.callWith(staleHandler, { method: "GET", path: API + "/probe" });
  assert.equal(stale.status, 503, "旧路由应报插件未激活，而不是继续用旧 core");
  assert.equal(stale.body.ok, false);
});

/* ---- 真实缺陷回归：fire() 的 spawn spec 必须带 cwd、失败不得静默关掉开关 ---- */

/** 推进到「倒计时走完」为止：真机上这一步由插件自己的定时器完成，测试里手动敲。 */
async function driveToFire(h, predicate) {
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    await sleep(120);
    await h.tick();
    if (await predicate()) return true;
  }
  return false;
}

await check("真发关机：spec 带 cwd/homedir 与 shutdown.exe，成功后清开关并进入 pending", async () => {
  const { h, dispose } = setup({ config: { dryRun: false } });
  try {
    await sleep(1050); // 让 countdownMs(1000) 走完
    await h.post("/set", { sessionId: "s1", armed: true });
    const fired = await driveToFire(h, async () => h.state.spawned.length > 0);
    assert.ok(fired, "应真下发一次");
    const spec = h.state.spawned[0];
    assert.ok(typeof spec.cwd === "string" && spec.cwd !== "", "cwd 必填（缺省会让 harness 校验 TypeError）");
    assert.equal(spec.argv[0], "C:\\Windows\\System32\\shutdown.exe");
    assert.deepEqual(spec.argv.slice(1, 3), ["/s", "/f"]);
    assert.ok(spec.argv.includes("/t") && spec.argv.includes("20"));
    assert.equal(spec.graceMs, 5000);
    const probe = (await h.get("/probe")).body.data;
    assert.ok(probe.pending, "应进入 pending（红色倒计时）");
    assert.deepEqual(probe.armedStates, [], "下发成功后开关表清空");
    assert.equal(probe.lastError, null);
  } finally {
    dispose();
  }
});

await check("下发失败：开关保持开启、记录 lastError、不进入 pending（绝不静默变回关闭）", async () => {
  const { h, dispose } = setup({ config: { dryRun: false } });
  h.state.spawnFails = true; // 模拟 harness 校验抛错
  try {
    await sleep(1050);
    await h.post("/set", { sessionId: "s1", armed: true });
    const failed = await driveToFire(h, async () => !!(await h.get("/probe")).body.data.lastError);
    assert.ok(failed, "应记录一次下发失败");
    const probe = (await h.get("/probe")).body.data;
    assert.equal(probe.pending, null);
    assert.match(probe.lastError.message, /includes/);
    const state = (await h.get("/state?sessionId=s1")).body.data;
    assert.equal(state.viewer.armed, true, "开关必须还在，绝不静默变回关闭");
    assert.ok(state.lastError, "UI 能读到失败原因");
  } finally {
    dispose();
  }
});

/* ----------------------------------------------------------------- report */

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length === 0) {
  console.log(`全部通过（${results.length} 项）`);
} else {
  console.log(`失败 ${failed.length} / ${results.length} 项`);
  process.exitCode = 1;
}
