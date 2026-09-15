# pi-bg-tasks

[中文文档](README.zh-CN.md)

Background task tools for the [pi coding agent](https://github.com/badlogic/pi-mono): run long commands without blocking the conversation, get results pushed back automatically when they finish.

## Highlights

- **~330 tokens. Total.** Measured static context injection: two tool schemas + one-line prompt snippets ≈ **331 tok/request** (chars/4, echo-capture method). The popular community alternative [`pi-background-tasks`](https://www.npmjs.com/package/pi-background-tasks) measures ≈ 5,000 tok with 11 tools — this is **~15× lighter**.
- **Two tools, nothing else.** `bg_run` + `bg_tail`. No slash commands, no widgets, no config surface, no other tools to trip over.
- **Zero dependencies, single file.** One ~260-line TypeScript file. pi bundles `typebox` and its own API — there is nothing to install. Copy the file into your extensions folder if you don't even want a package.
- **Fire-and-forget.** The model is told "results are pushed automatically; do not poll" — no wasted turns checking on tasks. Completion messages arrive as steering messages that trigger a turn.

## What is this?

pi's built-in `bash` tool blocks the agent until the command exits. For dev servers, builds, watchers, and other long-running work, that wastes the turn — or pushes the model toward polling loops.

`pi-bg-tasks` adds exactly two custom tools:

| Tool | Purpose |
|---|---|
| `bg_run` | Start a command in the background, get an id and log path immediately |
| `bg_tail` | (Fallback) read a task's status and recent output |

When a task exits, the extension pushes a message into the conversation with the last 4 KB of output and triggers a turn — the agent sees the result without being asked.

## Install

```bash
pi install git:github.com/35iter-cn/pi-bg-tasks
```

Then restart pi — the `bg_run` and `bg_tail` tools appear automatically.

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
| `timeoutSeconds` | number, optional | Kill the task after this many seconds. Default 1800, max 86400 |

Returns immediately with a task id, pid, and log path.

### `bg_tail`

| Parameter | Type | Description |
|---|---|---|
| `id` | string, required | Task id (or unambiguous prefix) |
| `bytes` | number, optional | Max bytes of log tail to return. Default 4096, max 65536 |

Mid-run reads are throttled to once per 30 s to discourage polling.

## How it works

- Output goes to `~/.pi/agent/bg-tasks/<timestamp>-<id>.log`; logs older than 7 days are cleaned up on session start.
- Processes run detached in their own process group, so they survive unrelated crashes and are killed as a group (`SIGTERM`, then `SIGKILL` after a 5 s grace period) on timeout.
- On exit, a completion message (with a 4 KB output tail) is delivered as a steering message with `triggerTurn`, so the agent picks it up on the spot.
- Session-replacement safe: if you run `/new`, fork, switch sessions, or `/reload` while a task is running, the stale completion notification is dropped instead of crashing pi. The log stays on disk — `bg_tail` can still fetch it.

## FAQ

**How is this different from the built-in bash tool?**
`bash` blocks the turn until the command exits. `bg_run` returns instantly and pushes the result later, so the agent stays responsive and doesn't burn turns polling.

**Windows?**
No — commands run through `/bin/sh`. POSIX systems only.

**Is it safe?**
It runs arbitrary shell commands with your user's permissions, exactly like pi's built-in bash tool. The usual pi extension security note applies: review the source before installing.

**Does the tool list bloat my context?**
Measured: ~330 tokens of static injection per request, all of it two compact tool definitions. See [Highlights](#highlights).

## License

[MIT](LICENSE)