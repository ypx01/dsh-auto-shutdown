/**
 * 客户端冒烟测试：不用浏览器，直接把 client.js 装进一个假模块表里执行，
 * 校验 slot 注册参数、组件在每种状态下的文案、以及点击发出的请求。
 *
 * 这不是替代真机渲染，而是把「文案/相位/请求体」这些最容易写错的东西钉住。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, "..", "client.js"), "utf8");

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push([name, e]);
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || "not equal"}\n       actual: ${JSON.stringify(actual)}\n     expected: ${JSON.stringify(expected)}`);
}

/* ------------------------------------------------------------- fake React */

function makeReact() {
  let stateCursor = 0;
  let refCursor = 0;
  const stateSlots = [];
  const refSlots = [];
  let effects = [];
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(init) {
      const idx = stateCursor++;
      if (!(idx in stateSlots)) stateSlots[idx] = typeof init === "function" ? init() : init;
      const set = (next) => {
        stateSlots[idx] = typeof next === "function" ? next(stateSlots[idx]) : next;
      };
      return [stateSlots[idx], set];
    },
    useRef(init) {
      const idx = refCursor++;
      if (!(idx in refSlots)) refSlots[idx] = { current: init };
      return refSlots[idx];
    },
    useEffect(fn) {
      effects.push(fn);
    },
  };
  return {
    React,
    beginRender() {
      stateCursor = 0;
      refCursor = 0;
      effects = [];
    },
    runEffects() {
      const cleanups = effects.map((fn) => fn());
      effects = [];
      return cleanups;
    },
    stateSlots,
  };
}

function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  for (const child of node.children ?? []) textOf(child, out);
  return out;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function findButton(tree) {
  let found = null;
  walk(tree, (node) => {
    if (!found && node.type === "button") found = node;
  });
  return found;
}

/* ---------------------------------------------------------- fake bootstrap */

function bootstrap(fetchImpl) {
  const react = makeReact();
  let captured = null;
  const styleNodes = [];
  const requests = [];

  const documentStub = {
    querySelector: () => null,
    createElement: (tag) => {
      const node = { tag, dataset: {}, textContent: "", parentNode: null };
      styleNodes.push(node);
      return node;
    },
    head: {
      appendChild(node) {
        node.parentNode = this;
      },
      removeChild(node) {
        node.parentNode = null;
      },
    },
  };

  const windowStub = {
    __ModuleLoader__: {
      load(registration) {
        captured = registration;
      },
    },
  };

  const sandbox = {
    window: windowStub,
    document: documentStub,
    navigator: { language: "zh-CN" },
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => ({ fake: true }),
    clearInterval: () => {},
    fetch: (url, options) => {
      requests.push({ url, options: options || {} });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(fetchImpl(url, options)) });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "client.js" });

  assert(captured, "client.js 没有调用 window.__ModuleLoader__.load");
  const mod = captured.factory((spec) => {
    if (spec === "react") return react.React;
    throw new Error(`unexpected require: ${spec}`);
  });

  return { registration: captured, mod, react, styleNodes, requests, fetchImpl };
}

function mount(fetchImpl) {
  const env = bootstrap(fetchImpl);
  const cleanups = [];
  const registrations = [];
  let effectCount = 0;
  const ctx = {
    effect(fn) {
      effectCount += 1;
      const cleanup = fn();
      if (typeof cleanup === "function") cleanups.push(cleanup);
    },
    slots: {
      inject(key, cb) {
        assert(key === "conversation.session.header.utilities", `unexpected slot key: ${key}`);
        return cb();
      },
      register(options, Component) {
        registrations.push({ options, Component });
        return () => {};
      },
    },
    sessions: {
      list: {
        getSnapshot: () => ({ current: "s1", byId: { s1: { id: "s1", cwd: "D:\\deepseek-workspace" } } }),
      },
    },
  };
  const dispose = env.mod.apply(ctx);
  return { ...env, ctx, registrations, cleanups, effectCount, dispose };
}

function renderState(env, data, props = {}) {
  const reg = env.registrations[0];
  assert(reg, "没有注册任何 slot 组件");
  const react = env.react;
  react.beginRender();
  let tree = reg.Component({ sessionId: "s1", ...props });
  // 第一次渲染是 loading 态；把快照塞进去后再渲染一次
  react.stateSlots[0] = { loading: false, data, error: null };
  react.beginRender();
  tree = reg.Component({ sessionId: "s1", ...props });
  return tree;
}

/* ------------------------------------------------------------------- cases */

console.log("客户端冒烟测试");

const IDLE = {
  supported: true,
  config: { countdownMs: 120000, shutdownGraceSeconds: 20 },
  viewer: { sessionId: "s1", armed: false, busy: false },
  armed: [],
  quiet: false,
  blocking: [],
  otherBusy: [],
  countdown: null,
  pending: null,
  lastFired: null,
};

check("模块表注册：id 等于包名，导出 inject/apply", () => {
  const env = bootstrap(() => ({ ok: true, data: {} }));
  eq(env.registration.id, "dsh-auto-shutdown", "loader id 必须等于包名");
  eq(typeof env.mod.apply, "function");
  assert(Array.isArray(env.mod.inject) && env.mod.inject.indexOf("slots") >= 0, "inject 必须含 slots");
});

check("slot 注册到会话标题栏工具区，order 30", () => {
  const env = mount(() => ({ ok: true, data: IDLE }));
  eq(env.registrations.length, 1);
  const opts = env.registrations[0].options;
  eq(opts.name, "conversation.session.header.utilities");
  eq(opts.id, "dsh-auto-shutdown");
  eq(opts.order, 30);
});

check("样式在 apply 里用 ctx.effect 注册并返回清理（factory 无副作用）", () => {
  const env = mount(() => ({ ok: true, data: IDLE }));
  eq(env.effectCount, 1);
  eq(env.styleNodes.length, 1, "应插入一个 style 节点");
  assert(env.styleNodes[0].textContent.indexOf(".dshas-btn") >= 0, "样式内容应写入");
  assert(typeof env.cleanups[0] === "function", "应返回清理函数");
});

check("默认关闭：role=switch、aria-checked=false、文案「自动关机」", () => {
  const env = mount(() => ({ ok: true, data: IDLE }));
  const tree = renderState(env, IDLE);
  const btn = findButton(tree);
  assert(btn, "应有 button");
  eq(btn.props.role, "switch");
  eq(btn.props["aria-checked"], "false");
  eq(btn.props["data-phase"], "idle");
  eq(textOf(tree).join(""), "自动关机");
});

check("已开启且还有活：显示等待会话数", () => {
  const env = mount(() => ({ ok: true, data: IDLE }));
  const data = {
    ...IDLE,
    viewer: { sessionId: "s1", armed: true, busy: true },
    armed: [{ sessionId: "s1", label: "a", busy: true, live: true, kinds: ["turn"] }],
    blocking: [{ sessionId: "s1", label: "a", kinds: ["turn"] }],
  };
  const tree = renderState(env, data);
  const btn = findButton(tree);
  eq(btn.props["aria-checked"], "true");
  eq(btn.props["data-phase"], "armed");
  assert(textOf(tree).join("").indexOf("等 1 个会话") >= 0, `actual: ${textOf(tree).join("")}`);
});

check("倒计时：显示秒数与 countdown 相位", () => {
  const env = mount(() => ({ ok: true, data: IDLE }));
  const data = {
    ...IDLE,
    viewer: { sessionId: "s1", armed: true, busy: false },
    armed: [{ sessionId: "s1", label: "a", busy: false, live: true, kinds: [] }],
    quiet: true,
    countdown: { deadline: Date.now() + 118000, remainingMs: 118000 },
  };
  const tree = renderState(env, data);
  const btn = findButton(tree);
  eq(btn.props["data-phase"], "countdown");
  eq(textOf(tree).join(""), "118 秒后关机");
});

check("已下发关机：显示 pending 相位与剩余秒", () => {
  const env = mount(() => ({ ok: true, data: IDLE }));
  const data = {
    ...IDLE,
    viewer: { sessionId: "s1", armed: false, busy: false },
    pending: { until: Date.now() + 17000, remainingMs: 17000 },
  };
  const tree = renderState(env, data);
  const btn = findButton(tree);
  eq(btn.props["data-phase"], "pending");
  eq(textOf(tree).join(""), "正在关机 17 秒");
});

check("非 Windows：按钮禁用并提示", () => {
  const env = mount(() => ({ ok: true, data: IDLE }));
  const tree = renderState(env, { ...IDLE, supported: false });
  const btn = findButton(tree);
  eq(btn.props.disabled, true);
  eq(textOf(tree).join(""), "仅支持 Windows");
});

check("点击开启：POST /set {sessionId, armed:true}", async () => {
  const env = mount((url) => {
    if (url.indexOf("/state") >= 0) return { ok: true, data: IDLE };
    return { ok: true, data: { state: { ...IDLE, viewer: { sessionId: "s1", armed: true } } } };
  });
  const tree = renderState(env, IDLE);
  const btn = findButton(tree);
  btn.props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  const posted = env.requests.filter((r) => r.options.method === "POST");
  eq(posted.length, 1, "应发一个 POST");
  assert(posted[0].url.endsWith("/api/auto-shutdown/set"), posted[0].url);
  eq(posted[0].options.body, JSON.stringify({ sessionId: "s1", armed: true }));
});

check("倒计时中点击：POST /cancel {sessionId}", async () => {
  const env = mount((url) => {
    if (url.indexOf("/state") >= 0) return { ok: true, data: IDLE };
    return { ok: true, data: { aborted: false, state: IDLE } };
  });
  const counting = {
    ...IDLE,
    viewer: { sessionId: "s1", armed: true },
    countdown: { deadline: Date.now() + 60000, remainingMs: 60000 },
  };
  const tree = renderState(env, counting);
  findButton(tree).props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  const posted = env.requests.filter((r) => r.options.method === "POST");
  eq(posted.length, 1);
  assert(posted[0].url.endsWith("/api/auto-shutdown/cancel"), posted[0].url);
  eq(JSON.parse(posted[0].options.body).sessionId, "s1");
});

check("接口失败：按钮仍可用并带错误 title", () => {
  const env = mount(() => ({ ok: false, error: "boom" }));
  const react = env.react;
  const reg = env.registrations[0];
  react.beginRender();
  reg.Component({ sessionId: "s1" });
  react.stateSlots[0] = { loading: false, data: null, error: "boom" };
  react.beginRender();
  const tree = reg.Component({ sessionId: "s1" });
  const btn = findButton(tree);
  assert(btn.props.title.indexOf("boom") >= 0, btn.props.title);
  eq(btn.props.disabled, false, "出错不应该把按钮锁死");
});

console.log(failures.length ? `\n失败 ${failures.length} / ${pass + failures.length}` : `\n全部通过（${pass} 项）`);
if (failures.length) process.exitCode = 1;
