# dsh-auto-shutdown — a per-session "shut down the PC when the work is done" switch

Adds a switch to the right side of every DSH session header:

| Switch | Behaviour |
| --- | --- |
| **Off** (default) | When the session finishes its work, **nothing happens** |
| **On** | Once this session — and every other session that also has the switch on — has nothing left running, a countdown starts and the machine shuts down |
| Several sessions on | **All** of them must finish; while any one is still busy, everyone waits |

- New sessions start **off**.
- Switch state is **not persisted**: after a DSH restart every switch is off again (a restart must never shut your machine down by surprise).

## How it decides the work is done

It does not guess, and it does not count events — it asks the harness itself:

```js
await ctx.waterfall('workspace/session-activity', { sessionId }, () => [])
// [] => this session has nothing left to do
```

This is the very same predicate DSH uses to refuse archiving a session that is still busy, and it already aggregates four kinds of activity:
`turn` (a conversation round in flight), `job` (background job), `subagent` (subagent run), `schedule` (scheduled/planned runs).
So a subagent that has not come back, or a background job that is still running, can never be mistaken for "done".

Event subscriptions (`session/event`, `api-session/status`) are only a fallback for when the waterfall is unavailable (for example right after a manual plugin reload); they also cancel the countdown **immediately** when a session starts doing something again.

## Three chances to change your mind

1. **Cool-down** (120 s by default): once all target sessions are idle a countdown starts and the button shows `118 s`. One click cancels it.
   If any session starts working again during the countdown, the countdown is dropped automatically.
2. **System countdown** (20 s by default): when the cool-down expires the plugin runs `shutdown.exe /s /f /t 20`.
   The button turns red — `Shutting down 18s` — and clicking it is `shutdown.exe /a`, i.e. an abort.
3. The machine actually powers off.

## Scope of the decision (configurable)

`requireGlobalQuiet: true` by default: on top of the sessions that have the switch on, **every other live session** (subagent sessions included) must be idle as well before the machine goes down — so "session A armed auto-shutdown while session B was still drafting" can never lose B's work.
Set it to `false` to look only at the armed sessions.

## Install

From the market / npm:

```
dsh plugin add dsh-auto-shutdown
```

From a local checkout (a symlink in the profile; reloading the plugin picks up source edits):

```
plugin_manager { action: "install_bundle", target: "D:\\path\\to\\dsh-auto-shutdown" }
```

After installing, refresh the Web GUI (the URL `dsh web` printed, e.g. `http://127.0.0.1:6673`); an "Auto shutdown" button appears on the right of the session header.

## Configuration

`config` in `cordis.patch.yml` (or override it in the profile composition):

| Key | Default | Meaning |
| --- | --- | --- |
| `countdownMs` | `120000` | Cool-down in milliseconds (minimum 1000) |
| `shutdownGraceSeconds` | `20` | The `N` in `shutdown /t N`; the window in which `/a` can still abort |
| `requireGlobalQuiet` | `true` | Whether every live session must be idle |
| `force` | `true` | Add `/f` so apps blocking shutdown can't leave it stuck on a confirmation prompt (which would defeat the whole point) |
| `dryRun` | `false` | Rehearse only: log the command instead of running it |
| `ignoreKinds` | `[]` | Activity kinds that must not block shutdown, e.g. `["schedule"]` |
| `debug` | `false` | Also write to stdout |
| `logFile` | `.dsh/auto-shutdown.log` | Log path; `null` disables the file (used by tests) |

Log: `%USERPROFILE%\.dsh\auto-shutdown.log` — one JSON object per line, covering every arm/disarm/countdown/command/abort.

## Self-check

```powershell
# 16 offline state-machine tests (fake ctx, never really shuts anything down)
node test\state-machine.test.mjs

# 11 client smoke tests (actually runs client.js and checks the wording and request bodies per state)
node test\client-smoke.test.mjs

# Runtime: compute the verdict only, change nothing:
#   GET http://127.0.0.1:<port>/api/auto-shutdown/probe

# Runtime: prove the command path really works (spawns a process, changes nothing):
#   POST http://127.0.0.1:<port>/api/auto-shutdown/self-test  {"realShutdown":false}
#   runs cmd /c exit 7; exitCode 7 proves spawn + cwd are fine
```

Two field groups in `probe` are the useful ones:

- `blocking` / `otherBusy`: who is still busy and with what (`turn` / `job` / `subagent` / `schedule`). Empty means it is safe to shut down.
- `stats.clientAlive`: whether the browser polled `/state` within the last 15 seconds. It proves the button really loaded and is alive, without looking at the UI.

HTTP surface (meant for the local UI only):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/auto-shutdown/state?sessionId=` | full state (countdown, blocking reasons) |
| GET | `/api/auto-shutdown/probe` | verdict only, mutates nothing |
| POST | `/api/auto-shutdown/set` | `{sessionId, armed}` |
| POST | `/api/auto-shutdown/cancel` | drop the countdown / run `shutdown /a` |
| POST | `/api/auto-shutdown/self-test` | `{realShutdown}`: really spawn a process to prove the path; `true` issues `shutdown /s /t 6000` and `/a` 1.5 s later |

## Development notes (scars, not theory)

- **`cwd` is mandatory in `ctx.subprocess.spawn(spec)`** (fixed 2026-10-26): the harness calls
  `validateNoNullByte("options.cwd", spec.cwd)`, which does `cwd.includes("\0")` — leave it out and you get
  `TypeError: Cannot read properties of undefined (reading 'includes')`. The type declaration makes `cwd`
  look optional; the implementation disagrees, so always pass it.
- **A failed dispatch must never silently turn the switch off.** The early `fire()` cleared `armed` before
  spawning; when the spawn threw, the switch was already gone and `pending` was never set — the user saw
  "countdown ends → button back to off → machine stays on". Now only a successful spawn clears the switches and
  enters `pending`; a failure keeps them on, records `lastError`, and the button reads "shutdown failed".
- **`apply`'s return value is not a disposer**: cordis only runs what `ctx.effect(fn)` returns. Unload/reload
  has to go through `ctx.effect`, otherwise the old route stays in the webServer, re-enabling hits
  `duplicate prefix route`, and the old handler closes over a dead core (a zombie route). This plugin keeps a
  module-level `state.core` behind one `dispatch`, so a leftover route simply points at the new instance, and
  returns 503 while the plugin is not active.
- **Host `index.js` is not hot-reloaded**: after editing, disable and re-enable the row
  (`plugin_manager set_plugin` with the entryId `include:auto-shutdown`, not the package name), or restart DSH.
- **The client module has to be re-delivered too**: refresh the page after installing.
- The CLI endpoints are unauthenticated (local only) — do not expose this prefix to the internet.

## Known limits

- **Windows only** (elsewhere the button says "Windows only" and refuses to arm).
- The DSH process must stay alive: it is the one issuing the shutdown. Quitting DSH means giving up this shutdown.
- Switches are not persisted (see above). Making them survive a restart would need `ctx.storageDomain`, which is
  deliberately not wired up — auto-shutdown that survives a restart is the more dangerous behaviour.
- With `requireGlobalQuiet: false`, a long-running job in some other session will not stop the shutdown; with
  `true`, one session that never becomes idle keeps the machine on (`probe` tells you who and why).
