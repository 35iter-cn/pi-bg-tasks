# pi-bg-tasks

[中文文档](README.zh-CN.md)

Background task tools for the [pi coding agent](https://github.com/badlogic/pi-mono): run long commands without blocking the conversation, get results pushed back automatically when they finish.

## Highlights

- **~800 tokens for the three core tools.** Static injection for `bg_run` + `bg_tail` + `bg_stop`: snippet, guidelines, description and parameter schema, measured at 4 characters per token. Roughly half of it is the guidelines block in the system prompt's rules section — the part that keeps the model from running a server in foreground bash; the two ops tools (`bg_list`, `bg_gc`) add one short paragraph each. The popular community alternative [`pi-background-tasks`](https://www.npmjs.com/package/pi-background-tasks) measures ≈ 5,000 tok with 11 tools.
- **Five tools, three of them core.** `bg_run` + `bg_tail` + `bg_stop` for the normal loop, plus `bg_list` / `bg_gc` for reattaching to and reaping tasks from earlier sessions. No slash commands, no widgets, no config surface.
- **Zero dependencies, single file.** One TypeScript file. pi bundles `typebox` and its own API — there is nothing to install. Copy the file into your extensions folder if you don't even want a package.
- **Survives one-shot sessions.** In `--print` / `json` / `rpc` mode the session may exit within seconds; its tasks keep running under a hard `timeout` watchdog and report back on the next session start.
- **Fire-and-forget, with one exception.** The description gives the model one decision rule (~10 seconds and up) and states that a completion arrives as its own message — the start receipt is the same in interactive and one-shot sessions. A server never exits, so readiness comes from its log: `bg_tail` it, and add one bounded port probe only when the log carries no readiness line. Never put a server in one call of a batch and its check in another — a batch runs in order, so the check never starts. Completion messages are delivered as steering messages that trigger a turn.

## What is this?

pi's built-in `bash` tool blocks the agent until the command exits. For dev servers, builds, watchers, and other long-running work, that wastes the turn — or pushes the model toward polling loops.

`pi-bg-tasks` adds five custom tools:

| Tool | Purpose |
|---|---|
| `bg_run` | Start a command in the background, get an id and log path immediately |
| `bg_tail` | (Fallback) read a task's status and recent output |
| `bg_stop` | Stop a task — this session's, or an orphan from an earlier one (kills the whole process group) |
| `bg_list` | List tasks on this machine, including ones started by sessions that are already gone |
| `bg_gc` | Reap tasks whose owning session is gone or whose deadline passed |

When a task exits and a session can still receive messages, the extension pushes one with the last 4 KB of output and triggers a turn — the agent sees the result without being asked.

## Install

```bash
pi install git:github.com/35iter-cn/pi-bg-tasks
```

Then restart pi — the `bg_run`, `bg_tail`, `bg_stop`, `bg_list`, and `bg_gc` tools appear automatically.

**Try without installing:**

```bash
pi -e git:github.com/35iter-cn/pi-bg-tasks
```

Loads the extension for the current session only. Nothing is written to your settings.

**Manual (single file):**

If you prefer not to install a package, copy
[`extensions/bg-run.ts`](extensions/bg-run.ts) into `~/.pi/agent/extensions/`.
No dependencies are needed — pi bundles `typebox` and its own API.

To update later:

```bash
pi update --extensions
```

## Tools

### `bg_run`

| Parameter | Type | Description |
|---|---|---|
| `command` | string, required | Shell command to run (via `/bin/sh -c`) |
| `name` | string, optional | Short task name; defaults to the first words of the command |
| `timeoutSeconds` | number, optional | Kill the task after this many seconds. Default 1800, max 86400. A service meant to outlive the session needs 86400 — the default is a runaway guard, not a lifespan |
| `wakeOnExit` | boolean, optional | Wake this conversation when the task ends after the owning job has exited. Defaults on in a relay worker that can reach `agent-relay` — see [Waking the conversation](#waking-the-conversation) |

Returns immediately with a task id, pid, and log path.

### `bg_stop`

| Parameter | Type | Description |
|---|---|---|
| `id` | string, required | Task id (or unambiguous prefix) |

Kills the whole process group (`SIGTERM`, then `SIGKILL` after a 5s grace period) and removes the task record. Works on this session's tasks and on orphans recorded on disk (the pid is validated against its `starttime` first, so a recycled pid is never killed by mistake). |

### `bg_tail`

| Parameter | Type | Description |
|---|---|---|
| `id` | string, required | Task id (or unambiguous prefix) |
| `bytes` | number, optional | Max bytes of log tail to return. Default 4096, max 65536 |

A repeat read returns only what the task appended since the last read, or says there is no new output.

### `bg_list`

| Parameter | Type | Description |
|---|---|---|
| `orphans` | boolean, optional | Only list tasks whose owning session is gone |

Newest first, with status, reap policy, age, whether the owner is still alive, and the log path.

### `bg_gc`

| Parameter | Type | Description |
|---|---|---|
| `dryRun` | boolean, optional | Report what would be reaped without killing anything |

Kills tasks marked `on-owner-exit` whose owner is gone, kills tasks past their deadline, and marks vanished processes as `lost`.

## Waking the conversation

A chat bridge runs one pi process per turn, so a task started in that turn can end long after the process is gone. Inside a relay worker (`AGENT_RELAY_PLATFORM` and `AGENT_RELAY_KEY` both set, mode not `tui`, `agent-relay` on `PATH`) `bg_run` appends a wake step to the task's own shell: when the command ends, the step compares `/proc/<owner>/stat` field 22 with the start ticks recorded at spawn, and if the owning process is gone it runs `agent-relay schedule --in 0s` against the same conversation key. The scheduled round resumes the same session, so the result comes back to the conversation that started the task.

| Situation | Behaviour |
|---|---|
| Task ends, owner alive | no wake — the in-turn steering message already delivered it |
| Task ends, owner gone | one wake round; its prompt starts with `自动唤醒` and carries rc, elapsed seconds and the last 2 KB of the log |
| Not a relay worker (interactive pi, `tui`) | `wake=off` in the start receipt; no wake step exists |
| `wakeOnExit: false` | off on request, even in a relay worker |
| No `agent-relay` on `PATH` at `bg_run` | `wake=unavailable` in the receipt and the ledger; nothing runs at exit |
| `agent-relay` gone by exit | `<id>.wake` holds `127`, the log says `wake: cli-missing` |
| Daemon down (exit 1) | three attempts 20 s apart; `<id>.wake` holds `1`, the log says `wake: daemon-down` |
| Refused (exit 3, e.g. `name-taken`) | one attempt; `<id>.wake` holds `3`, the reason is in the log |

The wake never changes the task's own exit code and each CLI call is capped at 20 s. `<id>.wake` holds the CLI's exit code (or `failed` when the step itself broke); the ledger's `wake` field holds what was decided at start. `BG_RUN_WAKE_RETRY_SECONDS` and `BG_RUN_WAKE_CLI_SECONDS` shorten the retry gap and the CLI budget.

## How it works

- Output goes to `~/.pi/agent/bg-tasks/<timestamp>-<id>.log`; logs older than 7 days are cleaned up on session start.
- Processes run detached in their own process group, and are killed as a group (`SIGTERM`, then `SIGKILL` after a 1 s grace period) on timeout or `bg_stop`. `timeout` itself runs with `--foreground` so it stays inside that same group — without it GNU timeout opens a group of its own and `bg_stop` would kill only the wrapper; where `timeout` has no `--foreground`, the task runs unwrapped and the deadline is enforced by an in-process timer instead. Timeout kills say so explicitly in the completion message — if the task was a long-running service, the model is told to restart it with `bg_run` and a larger `timeoutSeconds`.
- **Reaping follows the runtime mode.** In an interactive session (`tui`), `session_shutdown` kills every task it started: closing pi takes its children down, as before. In a one-shot run (`--print`, `json`, `rpc`) shutdown leaves the tasks running, records the owner exit in the ledger, and they are reported on the next session start.
- **Every task carries a hard deadline.** The command runs under `timeout --foreground -k 5 <timeoutSeconds>`, so it dies at its deadline even if the pi process that started it is long gone. On timeout the whole process group is killed, which also catches grandchildren the wrapper did not parent.
- **State lives on disk**, not in the process: `~/.pi/agent/bg-tasks/<id>.json` (ledger: pid, pgid, `starttime`, deadline, owner, reap policy, status) and `<id>.exit` (exit code + finish time). That is what makes an exit observable across processes.
- On exit, when a session can still receive messages, a completion message (with a 4 KB output tail) is delivered as a steering message with `triggerTurn`, and the ledger is marked notified.
- Session-replacement safe: if you run `/new`, fork, switch sessions, or `/reload`, a stale completion notification is dropped instead of crashing pi. (Session replacement kills this session's tasks first by design, so what you receive afterwards is the kill notification.) The log stays on disk — `bg_tail` can still fetch it.

## FAQ

**How is this different from the built-in bash tool?**
`bash` blocks the turn until the command exits. `bg_run` returns instantly and pushes the result later, so the agent stays responsive and doesn't burn turns polling.

**Windows?**
No — commands run through `/bin/sh`. POSIX systems only.

**Is it safe?**
It runs arbitrary shell commands with your user's permissions, exactly like pi's built-in bash tool. The usual pi extension security note applies: review the source before installing.

**Does the tool list bloat my context?**
The three core tools measure ~800 tokens of static injection (snippet + guidelines + description + schema); the two ops tools are a short paragraph each. See [Highlights](#highlights).

**Do tasks survive pi exiting?**
It depends on the mode. Interactive (`tui`): no, they die with the session, exactly as before. One-shot (`--print`, `json`, `rpc`, which is how chat bridges run pi): yes — they keep running under their `timeout` deadline, and the next session start reports whichever of them finished in the meantime. In a relay worker the task also wakes its own conversation when it ends after the turn — see [Waking the conversation](#waking-the-conversation). `bg_list` shows what is still alive, `bg_gc` reaps what nobody owns any more.

**Is there a chance a task outlives everything?**
No. The deadline is enforced by `timeout` inside the task's own process group, so it does not depend on pi being alive. `bg_gc` and the session-start sweep only clean up earlier.

## License

[MIT](LICENSE)