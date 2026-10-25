import {
	openSync,
	closeSync,
	readSync,
	statSync,
	readdirSync,
	unlinkSync,
	mkdirSync,
	existsSync,
	readFileSync,
	writeFileSync,
	renameSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOG_DIR = process.env.BG_RUN_DIR || join(homedir(), ".pi", "agent", "bg-tasks");
const DEFAULT_TIMEOUT_SECONDS = 1800;
const MAX_TIMEOUT_SECONDS = 86400;
const THROTTLE_MS = 30_000;
const NOTIFY_TAIL_BYTES = 4096;
const LEDGER_RETENTION_MS = 7 * 24 * 3600 * 1000;

const SERVICE_TIMEOUT_HINT = "A service meant to outlive the session needs 86400 — the default is a runaway guard, not a lifespan.";

type ReapPolicy = "on-owner-exit" | "deadline";
type TaskStatus = "running" | "exited" | "timedout" | "killed" | "lost";

type Task = {
	id: string;
	name: string;
	command: string;
	logPath: string;
	pid: number | undefined;
	pgid: number | undefined;
	startTicks: string | undefined;
	startedAt: number;
	deadlineAt: number;
	timeoutSeconds: number;
	mode: string;
	sessionKey: string;
	reapPolicy: ReapPolicy;
	killTimer: ReturnType<typeof setTimeout> | undefined;
	exited: boolean;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	lastTailAt: number;
	notified: boolean;
};

type Ledger = {
	id: string;
	name: string;
	command: string;
	logPath: string;
	pid: number | undefined;
	pgid: number | undefined;
	startTicks: string | undefined;
	startedAt: number;
	deadlineAt: number;
	timeoutSeconds: number;
	mode: string;
	sessionKey: string;
	reapPolicy: ReapPolicy;
	owner: { pid: number; startTicks: string | undefined; mode: string; sessionKey: string };
	ownerExitedAt?: number;
	status: TaskStatus;
	exitCode: number | null;
	signal: string | null;
	finishedAt: number | null;
	notified: boolean;
};

const tasks = new Map<string, Task>();
const tailedAt = new Map<string, number>();

let currentMode = "tui";
let currentSessionKey = "";
let resolvedShell: string | undefined;
let timeoutAvailable: boolean | undefined;

function resolveShell(): string {
	if (resolvedShell) return resolvedShell;
	const candidate = process.env.BG_RUN_SHELL || "bash";
	try {
		if (spawnSync(candidate, ["-c", "exit 0"], { stdio: "ignore" }).status === 0) {
			return (resolvedShell = candidate);
		}
	} catch {}
	return (resolvedShell = "/bin/sh");
}

function hasTimeoutCommand(): boolean {
	if (timeoutAvailable !== undefined) return timeoutAvailable;
	try {
		timeoutAvailable = spawnSync("timeout", ["--version"], { stdio: "ignore" }).status === 0;
	} catch {
		timeoutAvailable = false;
	}
	return timeoutAvailable;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readStat(pid: number): string | undefined {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
		const tail = raw.slice(raw.lastIndexOf(")") + 2);
		const fields = tail.split(" ");
		return fields[19];
	} catch {
		return undefined;
	}
}

function pidAlive(pid: number | undefined, startTicks?: string): boolean {
	if (pid === undefined) return false;
	if (startTicks !== undefined) {
		const live = readStat(pid);
		if (live === undefined) return false;
		return live === startTicks;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const BgRunParams = Type.Object({
	command: Type.String({ description: "Shell command to run in the background" }),
	name: Type.Optional(
		Type.String({ description: "Short human-readable task name; defaults to the first words of the command" }),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description: `Kill the task after this many seconds; default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}. ${SERVICE_TIMEOUT_HINT}`,
		}),
	),
});

const BgTailParams = Type.Object({
	id: Type.String({ description: "Task id or unambiguous prefix" }),
	bytes: Type.Optional(
		Type.Number({ description: "Max bytes of log tail to return; default 4096, max 65536" }),
	),
});

const BgStopParams = Type.Object({
	id: Type.String({ description: "Task id or unambiguous prefix" }),
});

const BgListParams = Type.Object({
	orphans: Type.Optional(
		Type.Boolean({ description: "Only show tasks whose owning session is gone (orphans)" }),
	),
});

const BgGcParams = Type.Object({
	dryRun: Type.Optional(Type.Boolean({ description: "Report what would be reaped without killing anything" })),
});

function resolveLogDir(): string {
	mkdirSync(LOG_DIR, { recursive: true });
	return LOG_DIR;
}

function defaultName(command: string): string {
	return command.trim().split(/\s+/).slice(0, 3).join(" ").slice(0, 60);
}

function readTail(logPath: string, bytes: number): string {
	let size = 0;
	try {
		size = statSync(logPath).size;
	} catch {
		return "(no output yet)";
	}
	if (size === 0) return "(no output yet)";
	const length = Math.min(bytes, size);
	const start = size - length;
	const fd = openSync(logPath, "r");
	try {
		const buf = Buffer.alloc(length);
		readSync(fd, buf, 0, length, start);
		let text = buf.toString("utf8");
		if (start > 0) text = `... (earlier output omitted, full log: ${logPath})\n` + text;
		return text;
	} finally {
		closeSync(fd);
	}
}

const TIMEOUT_HINT = " auto-killed because timeoutSeconds was reached — if this was meant to be a long-running service, restart it with a larger timeoutSeconds.";

function statusLine(status: TaskStatus, exitCode: number | null, signal: string | null, timeoutSeconds: number): string {
	if (status === "timedout") return `timed out after ${timeoutSeconds}s (killed).${TIMEOUT_HINT}`;
	if (status === "killed") return signal ? `killed by ${signal}` : "killed";
	if (status === "lost") return "lost (process is gone and no exit record was written)";
	return exitCode === 0 ? "completed with exit code 0" : `failed with exit code ${exitCode}`;
}

function ledgerPath(id: string): string {
	return join(LOG_DIR, `${id}.json`);
}

function exitPath(id: string): string {
	return join(LOG_DIR, `${id}.exit`);
}

function writeLedger(ledger: Ledger): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		const target = ledgerPath(ledger.id);
		const tmp = `${target}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(ledger, null, 2));
		renameSync(tmp, target);
	} catch {}
}

function readLedger(id: string): Ledger | undefined {
	try {
		return JSON.parse(readFileSync(ledgerPath(id), "utf8")) as Ledger;
	} catch {
		return undefined;
	}
}

function listLedgers(): Ledger[] {
	if (!existsSync(LOG_DIR)) return [];
	const out: Ledger[] = [];
	for (const file of readdirSync(LOG_DIR)) {
		if (!/^[0-9a-f]{8}\.json$/.test(file)) continue;
		const ledger = readLedger(file.slice(0, 8));
		if (ledger) out.push(ledger);
	}
	return out.sort((a, b) => b.startedAt - a.startedAt);
}

function readExit(id: string): { code: number; finishedAt: number } | undefined {
	try {
		const raw = readFileSync(exitPath(id), "utf8").trim();
		const [codeRaw, tsRaw] = raw.split(/\s+/);
		const code = Number.parseInt(codeRaw ?? "", 10);
		if (Number.isNaN(code)) return undefined;
		const seconds = Number.parseInt(tsRaw ?? "", 10);
		return { code, finishedAt: Number.isNaN(seconds) ? Date.now() : seconds * 1000 };
	} catch {
		return undefined;
	}
}

function ledgerFromTask(task: Task): Ledger {
	return {
		id: task.id,
		name: task.name,
		command: task.command,
		logPath: task.logPath,
		pid: task.pid,
		pgid: task.pgid,
		startTicks: task.startTicks,
		startedAt: task.startedAt,
		deadlineAt: task.deadlineAt,
		timeoutSeconds: task.timeoutSeconds,
		mode: task.mode,
		sessionKey: task.sessionKey,
		reapPolicy: task.reapPolicy,
		owner: { pid: process.pid, startTicks: readStat(process.pid), mode: task.mode, sessionKey: task.sessionKey },
		status: task.timedOut ? "timedout" : task.exited ? (task.signal ? "killed" : "exited") : "running",
		exitCode: task.exitCode,
		signal: task.signal,
		finishedAt: task.exited ? Date.now() : null,
		notified: task.notified,
	};
}

function killTask(task: Task): void {
	const pid = task.pgid ?? task.pid;
	if (pid === undefined || task.exited) return;
	try {
		process.kill(-pid, "SIGTERM");
	} catch {}
	const grace = setTimeout(() => {
		if (task.exited) return;
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}, 5_000);
	grace.unref();
}

function killLedger(ledger: Ledger): boolean {
	const pid = ledger.pgid ?? ledger.pid;
	if (pid === undefined) return false;
	if (!pidAlive(pid, ledger.startTicks)) return false;
	try {
		process.kill(-pid, "SIGTERM");
	} catch {}
	const target = pid;
	const grace = setTimeout(() => {
		try {
			process.kill(-target, "SIGKILL");
		} catch {}
	}, 5_000);
	grace.unref();
	return true;
}

function taskFileIds(): string[] {
	if (!existsSync(LOG_DIR)) return [];
	const ids = new Set<string>();
	for (const file of readdirSync(LOG_DIR)) {
		const match = /-([0-9a-f]{8})\.log$/.exec(file) ?? /^([0-9a-f]{8})\.json$/.exec(file);
		if (match?.[1]) ids.add(match[1]);
	}
	return [...ids];
}

function resolveTask(idOrPrefix: string): { task?: Task; fileId?: string; candidates?: string[] } {
	const ids = [...new Set([...tasks.keys(), ...taskFileIds()])];
	const exact = ids.find((id) => id === idOrPrefix);
	if (exact) return tasks.has(exact) ? { task: tasks.get(exact) } : { fileId: exact };
	const matches = ids.filter((id) => id.startsWith(idOrPrefix));
	if (matches.length === 1) {
		const id = matches[0];
		return tasks.has(id) ? { task: tasks.get(id) } : { fileId: id };
	}
	if (matches.length === 0) return {};
	return { candidates: matches };
}

function findLogFile(id: string): string | undefined {
	if (!existsSync(LOG_DIR)) return undefined;
	const file = readdirSync(LOG_DIR).find((f) => f.endsWith(`-${id}.log`));
	return file ? join(LOG_DIR, file) : undefined;
}

function cleanupOldLogs(): void {
	if (!existsSync(LOG_DIR)) return;
	const cutoff = Date.now() - LEDGER_RETENTION_MS;
	for (const file of readdirSync(LOG_DIR)) {
		const idMatch = /-([0-9a-f]{8})\.log$/.exec(file);
		if (!idMatch) continue;
		const path = join(LOG_DIR, file);
		let old = false;
		try {
			old = statSync(path).mtimeMs < cutoff;
		} catch {
			continue;
		}
		if (!old) continue;
		const ledger = readLedger(idMatch[1]!);
		if (ledger && ledger.status === "running" && pidAlive(ledger.pgid ?? ledger.pid, ledger.startTicks)) continue;
		try {
			unlinkSync(path);
		} catch {}
	}
	for (const file of readdirSync(LOG_DIR)) {
		if (!/^[0-9a-f]{8}\.(json|exit)$/.test(file)) continue;
		const path = join(LOG_DIR, file);
		try {
			if (statSync(path).mtimeMs >= cutoff) continue;
		} catch {
			continue;
		}
		const ledger = readLedger(file.slice(0, 8));
		if (ledger && ledger.status === "running" && pidAlive(ledger.pgid ?? ledger.pid, ledger.startTicks)) continue;
		try {
			unlinkSync(path);
		} catch {}
	}
}

function modeHint(): string {
	return currentMode === "tui"
		? ""
		: " This session is one-shot: the result will not come back to this turn. Use bg_tail to read it now, or let it finish and the next session start will report it.";
}

function formatLedgerLine(ledger: Ledger): string {
	const age = Math.round((Date.now() - ledger.startedAt) / 1000);
	const alive = pidAlive(ledger.pgid ?? ledger.pid, ledger.startTicks);
	const ownerAlive = pidAlive(ledger.owner?.pid, ledger.owner?.startTicks);
	const state = ledger.status === "running" ? (alive ? "running" : "gone") : ledger.status;
	return `${ledger.id}  ${state.padEnd(8)} ${ledger.reapPolicy.padEnd(13)} age=${age}s owner=${ownerAlive ? "alive" : "gone"}  ${ledger.name}  log=${ledger.logPath}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		currentMode = (ctx as { mode?: string } | undefined)?.mode ?? "tui";
		try {
			currentSessionKey = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)?.sessionManager?.getSessionId?.() ?? "";
		} catch {
			currentSessionKey = "";
		}
		cleanupOldLogs();
		for (const ledger of listLedgers()) {
			if (tasks.has(ledger.id)) continue;
			const exit = readExit(ledger.id);
			if (exit) {
				if (ledger.status === "running") {
					ledger.status = exit.code === 124 || exit.code === 137 ? "timedout" : "exited";
					ledger.exitCode = exit.code;
					ledger.finishedAt = exit.finishedAt;
					writeLedger(ledger);
				}
				const sameSession = !currentSessionKey || !ledger.sessionKey || ledger.sessionKey === currentSessionKey;
				if (!ledger.notified && sameSession) {
					const tail = readTail(ledger.logPath, NOTIFY_TAIL_BYTES);
					const suffix = statusLine(ledger.status, ledger.exitCode, ledger.signal, ledger.timeoutSeconds);
					try {
						pi.sendMessage(
							{
								customType: "minimal-bg",
								content: `Background task ${ledger.name} (${ledger.id}) ${suffix} while no session was attached\n${tail}`,
								display: true,
								details: { id: ledger.id, name: ledger.name, exitCode: ledger.exitCode, signal: ledger.signal, timedOut: ledger.status === "timedout", logPath: ledger.logPath },
							},
							{ deliverAs: "nextTurn" },
						);
						ledger.notified = true;
					} catch {}
					writeLedger(ledger);
				}
				continue;
			}
			if (ledger.status !== "running") continue;
			const alive = pidAlive(ledger.pgid ?? ledger.pid, ledger.startTicks);
			if (!alive) {
				ledger.status = "lost";
				ledger.finishedAt = Date.now();
				writeLedger(ledger);
				continue;
			}
			const ownerAlive = pidAlive(ledger.owner?.pid, ledger.owner?.startTicks);
			if (ledger.reapPolicy === "on-owner-exit" && !ownerAlive) {
				killLedger(ledger);
				ledger.status = "killed";
				ledger.signal = "SIGTERM";
				ledger.finishedAt = Date.now();
				writeLedger(ledger);
				continue;
			}
			if (Date.now() > ledger.deadlineAt) {
				killLedger(ledger);
				ledger.status = "timedout";
				ledger.finishedAt = Date.now();
				writeLedger(ledger);
			}
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const mode = (ctx as { mode?: string } | undefined)?.mode ?? currentMode;
		for (const task of tasks.values()) {
			if (mode === "tui") {
				killTask(task);
				const ledger = ledgerFromTask(task);
				ledger.status = "killed";
				ledger.signal = "SIGTERM";
				ledger.finishedAt = Date.now();
				ledger.notified = true;
				writeLedger(ledger);
				continue;
			}
			const ledger = ledgerFromTask(task);
			ledger.ownerExitedAt = Date.now();
			ledger.notified = true;
			writeLedger(ledger);
		}
		tasks.clear();
	});

	pi.registerTool<typeof BgRunParams, { id: string }>({
		name: "bg_run",
		label: "Background Run",
		promptSnippet: "Run anything slower than ~10 seconds in the background; returns immediately, result arrives as a new turn",
		description:
			"Run a shell command in the background and return at once with an id and log path. Decide by runtime, not by command type: anything likely to exceed ~10 seconds belongs here, unknown durations included; foreground bash is only for commands you know finish instantly. An extra turn is cheap, a blocked turn is not. Completion is pushed as a new message when the session can receive one, so nothing is gained by waiting inside your turn: do independent work, or end the turn. Every task carries a hard deadline and is killed when it is reached.",
		parameters: BgRunParams,
		async execute(_toolCallId, params: Static<typeof BgRunParams>) {
			const dir = resolveLogDir();
			const id = randomUUID().slice(0, 8);
			const name = params.name?.trim() || defaultName(params.command);
			const timeoutSeconds = Math.min(Math.max(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 1), MAX_TIMEOUT_SECONDS);
			const shell = resolveShell();
			const logPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}.log`);
			const exitFile = exitPath(id);
			const logFd = openSync(logPath, "a");
			const reapPolicy: ReapPolicy = currentMode === "tui" ? "on-owner-exit" : "deadline";
			const inner = hasTimeoutCommand()
				? `timeout -k 5 ${timeoutSeconds} ${shell} -c ${shellQuote(params.command)}`
				: `${shell} -c ${shellQuote(params.command)}`;
			const script = `${inner}; code=$?; printf '%s %s\\n' "$code" "$(date +%s)" > ${shellQuote(exitFile)}; if [ "$code" = 124 ] || [ "$code" = 137 ]; then kill -KILL 0 2>/dev/null; fi`;
			const child = spawn(shell, ["-c", script], {
				detached: true,
				stdio: ["ignore", logFd, logFd],
			});
			closeSync(logFd);
			const task: Task = {
				id,
				name,
				command: params.command,
				logPath,
				pid: child.pid,
				pgid: child.pid,
				startTicks: child.pid === undefined ? undefined : readStat(child.pid),
				startedAt: Date.now(),
				deadlineAt: Date.now() + timeoutSeconds * 1000,
				timeoutSeconds,
				mode: currentMode,
				sessionKey: currentSessionKey,
				reapPolicy,
				killTimer: undefined,
				exited: false,
				exitCode: null,
				signal: null,
				timedOut: false,
				lastTailAt: 0,
				notified: false,
			};
			tasks.set(id, task);
			writeLedger(ledgerFromTask(task));
			if (!hasTimeoutCommand()) {
				task.killTimer = setTimeout(() => {
					task.timedOut = true;
					killTask(task);
				}, timeoutSeconds * 1000);
				task.killTimer.unref();
			}
			child.on("exit", (code, signal) => {
				task.exited = true;
				task.exitCode = code;
				task.signal = signal;
				if (task.killTimer) clearTimeout(task.killTimer);
				const recorded = readExit(id);
				if (recorded && (recorded.code === 124 || recorded.code === 137)) task.timedOut = true;
				task.timedOut = task.timedOut || code === 124 || code === 137;
				const tail = readTail(logPath, NOTIFY_TAIL_BYTES);
				const status: TaskStatus = task.timedOut ? "timedout" : signal ? "killed" : "exited";
				const suffix = statusLine(status, code, signal, task.timeoutSeconds);
				try {
					pi.sendMessage(
						{
							customType: "minimal-bg",
							content: `Background task ${name} (${id}) ${suffix}\n${tail}`,
							display: true,
							details: { id, name, exitCode: code, signal, timedOut: task.timedOut, logPath },
						},
						{ triggerTurn: true, deliverAs: "steer" },
					);
					task.notified = true;
				} catch {}
				writeLedger(ledgerFromTask(task));
			});
			child.unref();
			return {
				content: [
					{
						type: "text",
						text: `Started background task ${name} (${id}), pid ${child.pid}, shell ${shell}, deadline ${timeoutSeconds}s. Log: ${logPath}.${currentMode === "tui" ? " Its result arrives as a new turn when the process exits; nothing done inside this turn makes it sooner." : ""}${modeHint()}`,
					},
				],
				details: { id, pid: child.pid, shell },
			};
		},
	});

	pi.registerTool<typeof BgTailParams, { id: string }>({
		name: "bg_tail",
		label: "Background Tail",
		description:
			"Read the status and output tail of a background task. Fallback only — completion is pushed as a new message when the session can receive one. Mid-run reads throttle to once per 30s.",
		parameters: BgTailParams,
		async execute(_toolCallId, params: Static<typeof BgTailParams>) {
			const bytes = Math.min(Math.max(params.bytes ?? 4096, 1), 65536);
			const resolved = resolveTask(params.id);
			if (resolved.candidates) {
				return {
					content: [{ type: "text", text: `Ambiguous id prefix; candidates: ${resolved.candidates.join(", ")}` }],
					details: { id: params.id },
				};
			}
			const task = resolved.task;
			const id = task?.id ?? resolved.fileId ?? "";
			const logPath = task?.logPath ?? readLedger(id)?.logPath ?? findLogFile(id);
			if (!id || !logPath || !existsSync(logPath)) {
				return { content: [{ type: "text", text: `No task found for id ${params.id}` }], details: { id: params.id } };
			}
			if (task) {
				if (!task.exited) {
					if (Date.now() - task.lastTailAt < THROTTLE_MS) {
						return {
							content: [
								{
									type: "text",
									text:
										currentMode === "tui"
											? `Task ${id} still running. Completion is a process-exit event, not a timed one, so checking again — or sleeping — makes the result arrive exactly as late. End your turn; the result comes back as a new turn.`
											: `Task ${id} still running. This session is one-shot, so ending the turn ends the job: read it again later, bg_stop it, or leave it running and the next session start will report its outcome.`,
								},
							],
							details: { id },
						};
					}
					task.lastTailAt = Date.now();
					return {
						content: [
							{
								type: "text",
								text: `Task ${id} (${task.name}) running since ${new Date(task.startedAt).toISOString()}, deadline in ${Math.max(0, Math.round((task.deadlineAt - Date.now()) / 1000))}s\n${readTail(logPath, bytes)}`,
							},
						],
						details: { id },
					};
				}
				const status: TaskStatus = task.timedOut ? "timedout" : task.signal ? "killed" : "exited";
				return {
					content: [
						{ type: "text", text: `Task ${id} (${task.name}): ${statusLine(status, task.exitCode, task.signal, task.timeoutSeconds)}\n${readTail(logPath, bytes)}` },
					],
					details: { id },
				};
			}
			const ledger = readLedger(id);
			if (!ledger) {
				return { content: [{ type: "text", text: `Task ${id}: unknown (no ledger found)\n${readTail(logPath, bytes)}` }], details: { id } };
			}
			const exit = readExit(id);
			const alive = pidAlive(ledger.pgid ?? ledger.pid, ledger.startTicks);
			if (ledger.status === "running" && alive) {
				const last = tailedAt.get(id) ?? 0;
				if (Date.now() - last < THROTTLE_MS) {
					return {
						content: [
							{
								type: "text",
								text:
									currentMode === "tui"
										? `Task ${id} still running (started by another session). End your turn; its completion will be reported when it exits.`
										: `Task ${id} still running (started by another session). This session is one-shot: read it again later, or leave it and the next session start will report its outcome.`,
							},
						],
						details: { id },
					};
				}
				tailedAt.set(id, Date.now());
				return {
					content: [
						{
							type: "text",
							text: `Task ${id} (${ledger.name}) running since ${new Date(ledger.startedAt).toISOString()}, deadline in ${Math.max(0, Math.round((ledger.deadlineAt - Date.now()) / 1000))}s, owner ${pidAlive(ledger.owner?.pid, ledger.owner?.startTicks) ? "alive" : "gone"}\n${readTail(logPath, bytes)}`,
						},
					],
					details: { id },
				};
			}
			const status: TaskStatus = ledger.status === "running" && !alive ? "lost" : ledger.status;
			const exitCode = ledger.exitCode ?? exit?.code ?? null;
			return {
				content: [
					{
						type: "text",
						text: `Task ${id} (${ledger.name}): ${statusLine(status, exitCode, ledger.signal, ledger.timeoutSeconds)}\n${readTail(logPath, bytes)}`,
					},
				],
				details: { id },
			};
		},
	});

	pi.registerTool<typeof BgStopParams, { id: string }>({
		name: "bg_stop",
		label: "Background Stop",
		promptSnippet: "Stop a background task started in this session",
		description:
			"Stop a background task started in this session. Kills the whole process group (SIGTERM, then SIGKILL after 5s). Prefer this over shelling out to kill.",
		parameters: BgStopParams,
		async execute(_toolCallId, params: Static<typeof BgStopParams>) {
			const resolved = resolveTask(params.id);
			if (resolved.candidates) {
				return { content: [{ type: "text", text: `Ambiguous id prefix; candidates: ${resolved.candidates.join(", ")}` }], details: { id: params.id } };
			}
			const task = resolved.task;
			if (task) {
				if (task.exited) {
					return { content: [{ type: "text", text: `Task ${task.id} (${task.name}) already ${statusLine(task.timedOut ? "timedout" : task.signal ? "killed" : "exited", task.exitCode, task.signal, task.timeoutSeconds)}` }], details: { id: task.id } };
				}
				if (task.killTimer) clearTimeout(task.killTimer);
				task.timedOut = false;
				killTask(task);
				tasks.delete(task.id);
				const ledger = ledgerFromTask(task);
				ledger.status = "killed";
				ledger.signal = "SIGTERM";
				ledger.finishedAt = Date.now();
				ledger.notified = true;
				writeLedger(ledger);
				return {
					content: [{ type: "text", text: `Stopped background task ${task.name} (${task.id}), pid ${task.pid}. Log: ${task.logPath}` }],
					details: { id: task.id, stopped: true },
				};
			}
			const id = resolved.fileId;
			const ledger = id ? readLedger(id) : undefined;
			if (!ledger) {
				return {
					content: [
						{
							type: "text",
							text: id
								? `Task ${id} is not running in this session (it already exited, or it was started in a previous session). Check its log: ${findLogFile(id) ?? "log cleaned up or not found"}.`
								: `No task found for id ${params.id}`,
						},
					],
					details: { id: params.id },
				};
			}
			const killed = killLedger(ledger);
			if (killed) {
				ledger.status = "killed";
				ledger.signal = "SIGTERM";
				ledger.finishedAt = Date.now();
				ledger.notified = true;
				writeLedger(ledger);
				return {
					content: [{ type: "text", text: `Stopped background task ${ledger.name} (${ledger.id}), pgid ${ledger.pgid ?? ledger.pid}. Log: ${ledger.logPath}` }],
					details: { id: ledger.id, stopped: true },
				};
			}
			return {
				content: [{ type: "text", text: `Task ${ledger.id} (${ledger.name}) is not running (already ${ledger.status}); nothing to stop. Log: ${ledger.logPath}` }],
				details: { id: ledger.id, stopped: false },
			};
		},
	});

	pi.registerTool<typeof BgListParams, { ids: string[] }>({
		name: "bg_list",
		label: "Background List",
		promptSnippet: "List background tasks, including ones started by earlier sessions",
		description:
			"List background tasks known on this machine, newest first, including tasks started by a previous session that outlived it. Use it to reattach to a service before starting a duplicate. orphans=true filters to tasks whose owning session is gone.",
		parameters: BgListParams,
		async execute(_toolCallId, params: Static<typeof BgListParams>) {
			const ledgers = listLedgers();
			const rows: string[] = [];
			let count = 0;
			for (const ledger of ledgers) {
				const ownerAlive = pidAlive(ledger.owner?.pid, ledger.owner?.startTicks);
				const alive = pidAlive(ledger.pgid ?? ledger.pid, ledger.startTicks);
				const orphan = ledger.status === "running" && !ownerAlive;
				if (params.orphans && !orphan) continue;
				if (!params.orphans && ledger.status !== "running" && !alive) {
					const age = Date.now() - ledger.startedAt;
					if (age > LEDGER_RETENTION_MS) continue;
				}
				rows.push(formatLedgerLine(ledger));
				count += 1;
			}
			const header = count === 0 ? "No background tasks." : `${count} task(s):\n`;
			return {
				content: [{ type: "text", text: header + rows.join("\n") }],
				details: { ids: ledgers.map((l) => l.id) },
			};
		},
	});

	pi.registerTool<typeof BgGcParams, { reaped: number }>({
		name: "bg_gc",
		label: "Background Collect",
		promptSnippet: "Reap background tasks whose owner is gone or whose deadline passed",
		description:
			"Reap background tasks that nobody owns any more: kills tasks marked on-owner-exit whose owning session is gone, and tasks past their deadline, and marks dead processes as lost. dryRun reports without killing.",
		parameters: BgGcParams,
		async execute(_toolCallId, params: Static<typeof BgGcParams>) {
			const actions: string[] = [];
			let reaped = 0;
			for (const ledger of listLedgers()) {
				if (tasks.has(ledger.id)) continue;
				if (ledger.status !== "running") continue;
				const alive = pidAlive(ledger.pgid ?? ledger.pid, ledger.startTicks);
				if (!alive) {
					actions.push(`${ledger.id} gone (marked lost)`);
					if (!params.dryRun) {
						ledger.status = "lost";
						ledger.finishedAt = Date.now();
						writeLedger(ledger);
					}
					reaped += 1;
					continue;
				}
				const ownerAlive = pidAlive(ledger.owner?.pid, ledger.owner?.startTicks);
				const overdue = Date.now() > ledger.deadlineAt;
				const orphanByPolicy = ledger.reapPolicy === "on-owner-exit" && !ownerAlive;
				if (!overdue && !orphanByPolicy) continue;
				const why = overdue ? "deadline passed" : "owner gone";
				actions.push(`${ledger.id} killed (${why})`);
				if (!params.dryRun) {
					killLedger(ledger);
					ledger.status = overdue ? "timedout" : "killed";
					ledger.signal = "SIGTERM";
					ledger.finishedAt = Date.now();
					ledger.notified = true;
					writeLedger(ledger);
				}
				reaped += 1;
			}
			const text = params.dryRun ? `Dry run: ${reaped} task(s) would be reaped.` : `Reaped ${reaped} task(s).`;
			return {
				content: [{ type: "text", text: actions.length ? `${text}\n${actions.join("\n")}` : text }],
				details: { reaped },
			};
		},
	});
}
