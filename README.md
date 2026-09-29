# pi-bg-tasks

[中文文档](README.zh-CN.md)

Background task tools for the [pi coding agent](https://github.com/badlogic/pi-mono): run long commands without blocking the conversation, get results pushed back automatically when they finish.

## Highlights

- **~450 tokens. Total.** Measured static context injection: three tool schemas + one-line prompt snippets. The popular community alternative [`pi-background-tasks`](https://www.npmjs.com/package/pi-background-tasks) measures ≈ 5,000 tok with 11 tools — this is **~11× lighter**.
- **Three tools, nothing else.** `bg_run` + `bg_tail` + `bg_stop`. No slash commands, no widgets, no config surface, no other tools to trip over.
- **Zero dependencies, single file.** One ~370-line TypeScript file. pi bundles `typebox` and its own API — there is nothing to install. Copy the file into your extensions folder if you don't even want a package.
- **Fire-and-forget.** The model is told "results are pushed automatically; do not poll" — no wasted turns checking on tasks. Completion messages arrive as steering messages that trigger a turn.

## What is this?

pi's built-in `bash` tool blocks the agent until the command exits. For dev servers, builds, watchers, and other long-running work, that wastes the turn — or pushes the model toward polling loops.

`pi-bg-tasks` adds exactly three custom tools:

| Tool | Purpose |
|---|---|
| `bg_run` | Start a command in the background, get an id and log path immediately |
| `bg_tail` | (Fallback) read a task's status and recent output |
| `bg_stop` | Stop a task started in this session (kills the whole process group) |

When a task exits, the extension pushes a message into the conversation with the last 4 KB of output and triggers a turn — the agent sees the result without being asked.

## Install

```bash
pi install git:github.com/35iter-cn/pi-bg-tasks
```

Then restart pi — the `bg_run`, `bg_tail`, and `bg_stop` tools appear automatically.

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
| `timeoutSeconds` | number, optional | Kill the task after this many seconds. Default 1800, max 86400. For long-running services (dev servers, watchers) pass 86400 — the default is a runaway guard for one-shot work (builds, tests), not a lifespan for servers |

Returns immediately with a task id, pid, and log path.

### `bg_stop`

| Parameter | Type | Description |
|---|---|---|
| `id` | string, required | Task id (or unambiguous prefix) |

Kills the whole process group (`SIGTERM`, then `SIGKILL` after a 5s grace period) and removes the task record. Only stops tasks started in the current session. |

### `bg_tail`

| Parameter | Type | Description |
|---|---|---|
| `id` | string, required | Task id (or unambiguous prefix) |
| `bytes` | number, optional | Max bytes of log tail to return. Default 4096, max 65536 |

Mid-run reads are throttled to once per 30 s to discourage polling.

## How it works

- Output goes to `~/.pi/agent/bg-tasks/<timestamp>-<id>.log`; logs older than 7 days are cleaned up on session start.
- Processes run detached in their own process group, and are killed as a group (`SIGTERM`, then `SIGKILL` after a 5 s grace period) on timeout or `bg_stop`. Timeout kills say so explicitly in the completion message — if the task was a long-running service, the model is told to restart it with a larger `timeoutSeconds`.
- **Tasks belong to the session that started them**: on `session_shutdown` (quit, `/new`, resume, fork, reload) every task started by that session is killed as a group. Tasks of other concurrently running pi instances are unaffected.
- On exit, a completion message (with a 4 KB output tail) is delivered as a steering message with `triggerTurn`, so the agent picks it up on the spot.
- Session-replacement safe: if you run `/new`, fork, switch sessions, or `/reload`, a stale completion notification is dropped instead of crashing pi. (Session replacement kills this session's tasks first by design, so what you receive afterwards is the kill notification.) The log stays on disk — `bg_tail` can still fetch it.

## FAQ

**How is this different from the built-in bash tool?**
`bash` blocks the turn until the command exits. `bg_run` returns instantly and pushes the result later, so the agent stays responsive and doesn't burn turns polling.

**Windows?**
No — commands run through `/bin/sh`. POSIX systems only.

**Is it safe?**
It runs arbitrary shell commands with your user's permissions, exactly like pi's built-in bash tool. The usual pi extension security note applies: review the source before installing.

**Does the tool list bloat my context?**
Measured: ~450 tokens of static injection per request — three compact tool definitions. See [Highlights](#highlights).

**Do tasks survive pi exiting?**
No. Tasks belong to their session: a normally-closing session (including quitting pi) takes its tasks down with it. Only if pi is killed with SIGKILL / loses power — no cleanup path runs — can a process group linger; clean it up manually in the next session.

## License

[MIT](LICENSE)