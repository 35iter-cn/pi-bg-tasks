import { openSync, closeSync, readSync, statSync, readdirSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOG_DIR = join(homedir(), ".pi", "agent", "bg-tasks");
const DEFAULT_TIMEOUT_SECONDS = 1800;
const MAX_TIMEOUT_SECONDS = 86400;
const THROTTLE_MS = 30_000;
const NOTIFY_TAIL_BYTES = 4096;

type Task = {
	id: string;
	name: string;
	command: string;
	logPath: string;
	pid: number | undefined;
	startedAt: number;
	timeoutSeconds: number;
	killTimer: ReturnType<typeof setTimeout> | undefined;
	exited: boolean;
	exitCode: number | null;
	signaled: boolean;
	timedOut: boolean;
	lastTailAt: number;
};

const tasks = new Map<string, Task>();

const BgRunParams = Type.Object({
	command: Type.String({ description: "Shell command to run in the background" }),
	name: Type.Optional(
		Type.String({ description: "Short human-readable task name; defaults to the first words of the command" }),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({ description: `Kill the task after this many seconds; default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}` }),
	),
});

const BgTailParams = Type.Object({
	id: Type.String({ description: "Task id or unambiguous prefix" }),
	bytes: Type.Optional(
		Type.Number({ description: "Max bytes of log tail to return; default 4096, max 65536" }),
	),
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

function statusLine(task: Task): string {
	if (task.timedOut) return `timed out after ${task.timeoutSeconds}s (killed)`;
	if (task.exited) return task.exitCode === 0 ? "completed with exit code 0" : `failed with exit code ${task.exitCode}`;
	return "running";
}

function killTask(task: Task): void {
	const pid = task.pid;
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

function taskFileIds(): string[] {
	if (!existsSync(LOG_DIR)) return [];
	return readdirSync(LOG_DIR)
		.map((file) => /-([0-9a-f]{8})\.log$/.exec(file)?.[1] ?? null)
		.filter((id): id is string => id !== null);
}

function resolveTask(idOrPrefix: string): { task?: Task; fileId?: string; candidates?: string[] } {
	const ids = [...tasks.keys(), ...taskFileIds().filter((id) => !tasks.has(id))];
	const exact = ids.find((id) => id === idOrPrefix);
	if (exact) return tasks.has(exact) ? { task: tasks.get(exact) } : { fileId: exact };
	const matches = [...new Set(ids.filter((id) => id.startsWith(idOrPrefix)))];
	if (matches.length === 1) {
		const id = matches[0];
		return tasks.has(id) ? { task: tasks.get(id) } : { fileId: id };
	}
	return { candidates: matches };
}

function findLogFile(id: string): string | undefined {
	if (!existsSync(LOG_DIR)) return undefined;
	const file = readdirSync(LOG_DIR).find((f) => f.endsWith(`-${id}.log`));
	return file ? join(LOG_DIR, file) : undefined;
}

function cleanupOldLogs(): void {
	if (!existsSync(LOG_DIR)) return;
	const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
	for (const file of readdirSync(LOG_DIR)) {
		if (!/-[0-9a-f]{8}\.log$/.test(file)) continue;
		try {
			if (statSync(join(LOG_DIR, file)).mtimeMs < cutoff) unlinkSync(join(LOG_DIR, file));
		} catch {}
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		cleanupOldLogs();
	});

	pi.registerTool<typeof BgRunParams, { id: string }>({
		name: "bg_run",
		label: "Background Run",
		promptSnippet: "Start a long-running command or app in the background; completion is pushed back automatically",
		description:
			"Start a command in the background and return immediately with an id and log path. Use for anything that keeps running or takes more than a few seconds: dev servers, watchers, builds, editors, agent CLIs, tmux/herdr launches. If the user names an underlying tool for a long-running launch, still use bg_run as the async wrapper: the named tool is the payload, bg_run is the mechanism. Quick commands belong in bash. Results are pushed on completion; do not poll.",
		parameters: BgRunParams,
		async execute(_toolCallId, params: Static<typeof BgRunParams>) {
			const dir = resolveLogDir();
			const id = randomUUID().slice(0, 8);
			const name = params.name?.trim() || defaultName(params.command);
			const timeoutSeconds = Math.min(Math.max(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 1), MAX_TIMEOUT_SECONDS);
			const logPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}.log`);
			const logFd = openSync(logPath, "a");
			const child = spawn("/bin/sh", ["-c", params.command], {
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
				startedAt: Date.now(),
				timeoutSeconds,
				killTimer: undefined,
				exited: false,
				exitCode: null,
				signaled: false,
				timedOut: false,
				lastTailAt: 0,
			};
			tasks.set(id, task);
			task.killTimer = setTimeout(() => {
				task.timedOut = true;
				killTask(task);
			}, timeoutSeconds * 1000);
			task.killTimer.unref();
			child.on("exit", (code, signal) => {
				task.exited = true;
				task.exitCode = code;
				task.signaled = signal !== null;
				if (task.killTimer) clearTimeout(task.killTimer);
				const tail = readTail(logPath, NOTIFY_TAIL_BYTES);
				const suffix = task.timedOut ? ` timed out after ${timeoutSeconds}s (killed)` : code === 0 ? " completed with exit code 0" : ` failed with exit code ${code}`;
				try {
					pi.sendMessage(
						{
							customType: "minimal-bg",
							content: `Background task ${name} (${id})${suffix}\n${tail}`,
							display: true,
							details: { id, name, exitCode: code, timedOut: task.timedOut, logPath },
						},
						{ triggerTurn: true, deliverAs: "steer" },
					);
				} catch {}
			});
			child.unref();
			return {
				content: [
					{
						type: "text",
						text: `Started background task ${name} (${id}), pid ${child.pid}. Log: ${logPath}. Result will be pushed automatically when the task finishes; do not poll.`,
					},
				],
				details: { id },
			};
		},
	});

	pi.registerTool<typeof BgTailParams, { id: string }>({
		name: "bg_tail",
		label: "Background Tail",
		description:
			"Read the status and output tail of a background task. Fallback only: results are pushed automatically on completion; do not poll. Mid-run reads throttle to once per 30s.",
		parameters: BgTailParams,
		async execute(_toolCallId, params: Static<typeof BgTailParams>) {
			const bytes = Math.min(Math.max(params.bytes ?? 4096, 1), 65536);
			const resolved = resolveTask(params.id);
			if (resolved.candidates) {
				return {
					content: [{ type: "text", text: `Ambiguous id prefix; candidates: ${resolved.candidates.join(", ")}` }],
				};
			}
			const task = resolved.task;
			const id = task?.id ?? resolved.fileId;
			const logPath = task?.logPath ?? findLogFile(id);
			if (!id || !logPath || !existsSync(logPath)) {
				return { content: [{ type: "text", text: `No task found for id ${params.id}` }] };
			}
			if (task && !task.exited) {
				if (Date.now() - task.lastTailAt < THROTTLE_MS) {
					return {
						content: [
							{
								type: "text",
								text: `Task ${id} still running; its result will be pushed automatically — wait for the notification instead of polling.`,
							},
						],
					};
				}
				task.lastTailAt = Date.now();
				return {
					content: [{ type: "text", text: `Task ${id} (${task.name}) running since ${new Date(task.startedAt).toISOString()}\n${readTail(logPath, bytes)}` }],
				};
			}
			const status = task
				? statusLine(task)
				: "unknown (session restarted)";
			return {
				content: [{ type: "text", text: `Task ${id}${task ? ` (${task.name})` : ""}: ${status}\n${readTail(logPath, bytes)}` }],
			};
		},
	});
}
