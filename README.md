# dsh-auto-shutdown — 每会话「任务完成后自动关机」开关

> English: [README.en.md](README.en.md)

给 DSH 的每个会话在标题栏右侧加一个开关：

| 开关 | 行为 |
| --- | --- |
| **关**（默认） | 任务全部执行完后**什么都不做** |
| **开** | 本会话（以及所有也开了开关的会话）手上的活全部执行完 → 倒计时 → 电脑自动关机 |
| 多个会话都开 | 必须**全部**会话都完成才关机；任何一个还在跑就等 |

- 新建会话默认是**关**。
- 开关状态**不落盘**：DSH 重启后全部复位为关（重启后不会莫名其妙关机）。

## 它怎么判断「任务执行完了」

不是猜的，也不是数事件，而是直接问 harness 自己：

```js
await ctx.waterfall('workspace/session-activity', { sessionId }, () => [])
// [] => 这个会话没活干了
```

这是 DSH 用来「拒绝归档还有活干的会话」的同一个判据，已经汇总了四类活动源：
`turn`（正在跑的一轮对话）、`job`（后台任务）、`subagent`（子代理）、`schedule`（定时/计划中的执行）。
所以子代理没跑完、后台 job 还在转，都不会被误判成「完成」。

事件订阅（`session/event` / `api-session/status`）只作为瀑布不可用时（例如手动重载插件）的降级路径，
另外负责在会话一有动作时**立刻**取消倒计时。

## 三级可反悔

1. **冷静期**（默认 120 秒）：所有目标会话都空闲后开始倒计时，按钮上会显示 `118 秒后关机`，点一下即可取消。
   倒数期间任何会话重新开始干活，倒计时自动作废。
2. **系统倒计时**（默认 20 秒）：冷静期到点后执行 `shutdown.exe /s /f /t 20`。
   此时按钮变成红色的 `正在关机 18 秒`，点它等于执行 `shutdown.exe /a` 撤销。
3. 真正关机。

## 判定范围（可配置）

默认 `requireGlobalQuiet: true`：除了开了开关的会话，**其它任何在线会话**（包括子代理会话）也都要空闲，
才会关机——避免出现「A 会话挂了自动关机，结果把 B 会话正在写的稿子关掉」。
只想看开了开关的会话，把它设为 `false`。

## 安装

插件目录：`D:\deepseek-workspace\plugins\dsh-auto-shutdown`

用 plug-in manager 装本地目录（软链，改了源码重载插件即生效）：

```
plugin_manager { action: "install_bundle", target: "D:\\deepseek-workspace\\plugins\\dsh-auto-shutdown" }
```

装完刷新 Web GUI（地址以 `dsh web` 启动时打印的为准，形如 `http://127.0.0.1:6673`），会话标题栏右侧应出现「自动关机」按钮。

## 配置

`cordis.patch.yml` 里的 `config`（也可直接在 profile 的组合里覆盖）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `countdownMs` | `120000` | 冷静期毫秒数（最小 1000） |
| `shutdownGraceSeconds` | `20` | 真正调 `shutdown /t N` 的 N，期间可 `/a` 撤销 |
| `requireGlobalQuiet` | `true` | 是否要求所有在线会话都空闲 |
| `force` | `true` | 是否加 `/f` 强制结束阻止关机的程序（不加可能卡在确认界面，自动化就白做） |
| `dryRun` | `false` | 只演练不真关机，日志里记录将要执行的命令 |
| `ignoreKinds` | `[]` | 不想让某类活动阻止关机时填，如 `["schedule"]` |
| `debug` | `false` | 同时打到 stdout |
| `logFile` | `.dsh/auto-shutdown.log` | 日志路径；填 `null` 关闭落盘（测试用） |

日志：`%USERPROFILE%\.dsh\auto-shutdown.log`（JSON 行，含每次 arm/disarm/倒计时/下发命令/撤销）。

## 自检

```powershell
# 16 项离线状态机测试（假 ctx，不发真关机）
node D:\deepseek-workspace\plugins\dsh-auto-shutdown\test\state-machine.test.mjs

# 11 项客户端冒烟测试（真跑 client.js，检查每种状态下的文案与请求体）
node D:\deepseek-workspace\plugins\dsh-auto-shutdown\test\client-smoke.test.mjs

# 运行时只看判定、不触发（<port> = dsh web 打印的端口，下同）：
#   GET http://127.0.0.1:<port>/api/auto-shutdown/probe

# 运行时验证「下发链路真的通」（只起子进程，不改电脑状态）：
#   POST http://127.0.0.1:<port>/api/auto-shutdown/self-test  {"realShutdown":false}
#   → 跑 cmd /c exit 7，返回 exitCode 7 即证明 spawn + cwd 正常
```

`probe` 里两类字段最有用：

- `blocking` / `otherBusy`：谁还在忙、忙的是哪一类（`turn` / `job` / `subagent` / `schedule`）。空 = 随时可以关机。
- `stats.clientAlive`：最近 15 秒内浏览器有没有在轮询 `/state`。它证明「按钮真的加载并活着」，
  不需要看 UI 也能自检。

HTTP 面（仅供本机 UI 使用）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/auto-shutdown/state?sessionId=` | 全量状态（含倒计时、阻塞原因） |
| GET | `/api/auto-shutdown/probe` | 只算判定，不改任何状态 |
| POST | `/api/auto-shutdown/set` | `{sessionId, armed}` |
| POST | `/api/auto-shutdown/cancel` | 撤销倒计时 / `shutdown /a` |
| POST | `/api/auto-shutdown/self-test` | `{realShutdown}`：真起子进程验证下发链路；`true` 会下发 `shutdown /s /t 6000` 并在 1.5 秒后 `/a` |

## 开发注意（踩过的坑）

- **`ctx.subprocess.spawn(spec)` 的 `cwd` 是必填的**（2026-10-26 修）：harness 的
  `validateNoNullByte("options.cwd", spec.cwd)` 会对 `cwd` 直接调 `.includes("\0")`，
  缺省即 `TypeError: Cannot read properties of undefined (reading 'includes')`。
  类型声明里 `cwd` 看起来可省，实现里不行——所以 spec 一律显式给 `cwd`。
- **下发失败绝不能静默关掉开关**：早期的 `fire()` 先 `armed.clear()` 再 spawn，spawn 抛错后
  开关已经没了、`pending` 也没设，用户看到的就是「倒计时结束 → 按钮变回关闭 → 电脑没关」。
  现在只有 spawn 成功才清开关并进入 `pending`；失败保留开关、写 `lastError`，按钮显示「关机失败」。
- **`apply` 的返回值不会被当作 disposer**：cordis 只执行 `ctx.effect(fn)` 返回的清理函数。
  卸载/重载必须靠 `ctx.effect`，否则旧路由留在 webServer 里，再次启用会撞
  `duplicate prefix route`，并且旧 handler 会闭包住已死的 core（僵尸路由）。
  本插件用模块级 `state.core` + 统一 `dispatch` 派发：残留的旧路由也只会指向新实例，
  插件未激活时返回 503。
- **host 的 `index.js` 不会热重载**：改完要禁用再启用这一行（`plugin_manager set_plugin`，
  target 用 `include:auto-shutdown` 这个 entryId，不是包名），或者在会话里重启 DSH。
- **客户端模块同样要重新下发**：装好后刷新页面才会加载 `client.js`。
- CLI 接口没有鉴权限制（仅本机可用），所以不要把这个前缀暴露到公网。

## 已知边界

- **仅 Windows**（非 Windows 会显示「仅支持 Windows」并拒绝开启）。
- DSH 进程必须活着：它是执行关机的那一方；退出 DSH 就等于放弃这次自动关机。
- 开关不持久化（见上）。要在重启后也生效，需要接 `ctx.storageDomain`，目前刻意没做——重启后自动关机是更危险的行为。
- `requireGlobalQuiet: false` 时，若其它会话正在跑长任务，到点会照样关机；反过来 `true` 且某个会话卡在「一直有活」的状态，会一直不关机（`probe` 会告诉你是谁、为什么）。
