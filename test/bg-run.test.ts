import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extPath = join(here, "..", "extensions", "bg-run.ts");
const LOADER = "/tmp/bg-test-loader.ts";
const OUT = join(tmpdir(), `bg-test-out-${process.pid}.json`);

// Each scenario runs in a dedicated bun subprocess that imports the real
// extension with a minimal fake ExtensionAPI, executes tools, and writes an
// observable result (exit-code checks against /proc, real sleep timings).
function scenario(body: string, out: object, env?: Record<string, string>) {
	const dir = env?.BG_RUN_DIR ?? join(tmpdir(), `bg-test-dir-${process.pid}-${Math.random().toString(16).slice(2, 10)}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		LOADER,
		`
		const dir = process.env.BG_RUN_DIR;
		const mod = await import(${JSON.stringify(extPath)});
		const tools = new Map(); const handlers = new Map();
		const sent = [];
		const pi = {
			registerTool: (spec) => tools.set(spec.name, spec),
			on: (ev, h) => { const l = handlers.get(ev) ?? []; l.push(h); handlers.set(ev, l); },
			sendMessage: (msg) => sent.push(msg),
		};
		await mod.default(pi);
		const bgRun = (params) => tools.get("bg_run").execute("call", params);
		const bgTail = (id) => tools.get("bg_tail").execute("call", { id });
		const bgStop = (id) => tools.get("bg_stop").execute("call", { id });
		const groupAlive = (pid) => { try { process.kill(-pid, 0); return true; } catch (e) { if (e.code === "ESRCH") return false; return true; } };
		let result = {}
		await (async () => { ${body} })();
		await Bun.write(${JSON.stringify(OUT)}, JSON.stringify({ ...(${JSON.stringify(out)}), ...result, sent }));
	`,
	);
	const run = spawnSync("bun", [LOADER], { encoding: "utf8", timeout: 30_000, env: { ...process.env, BG_RUN_DIR: dir, ...env } });
	if (run.status !== 0) throw new Error(`scenario failed: ${run.stderr}`);
	const dumped = JSON.parse(readFileSync(OUT, "utf8"));
	rmSync(OUT, { force: true });
	return dumped;
}

const wait = (ms: number) => `await new Promise(r => setTimeout(r, ${ms}));`;

test("registers five tools and two lifecycle handlers", () => {
	const r = scenario(`result = { tools: [...tools.keys()].sort(), hasStart: handlers.has("session_start"), hasShutdown: handlers.has("session_shutdown") }`, {});
	assert.deepEqual(r.tools, ["bg_gc", "bg_list", "bg_run", "bg_stop", "bg_tail"]);
	assert.equal(r.hasStart, true);
	assert.equal(r.hasShutdown, true);
});

test("service timeout hint present in bg_run description and schema", () => {
	const r = scenario(
		`result = { desc: tools.get("bg_run").description, schema: tools.get("bg_run").parameters.properties.timeoutSeconds.description }`,
		{},
	);
	assert.match(r.desc, /~10 seconds/);
	assert.match(r.schema, /86400/);
	assert.match(r.schema, /outlive the session/);
});

test("timed-out completion message includes root-cause hint", { timeout: 30_000 }, async () => {
	const r = scenario(
		`
		const run = await bgRun({ command: "sleep 5", timeoutSeconds: 1 });
		${wait(2500)}
		const tail = await bgTail(run.details.id);
		const pushed = sent.find(m => m.customType === "minimal-bg" && /timed out/.test(m.content));
		result = { tail: tail.content[0].text, pushedText: pushed?.content ?? null, pid: run.details.pid };
		`,
		{},
	);
	assert.match(r.tail, /timed out after 1s \(killed\)/);
	assert.match(r.tail, /restart it with a larger timeoutSeconds/);
	assert.ok(r.pushedText, "completion message was pushed");
	assert.match(r.pushedText, /restart it with a larger timeoutSeconds/);
});

test("timeout kill terminates the whole process group", { timeout: 30_000 }, async () => {
	const r = scenario(
		`
		const run = await bgRun({ command: "sleep 30 & sleep 30", timeoutSeconds: 1 });
		${wait(3000)}
		result = { alive: groupAlive(run.details.pid) };
		`,
		{},
	);
	assert.equal(r.alive, false);
});

test("bg_stop kills the process group immediately", { timeout: 30_000 }, async () => {
	const r = scenario(
		`
		const run = await bgRun({ command: "sleep 60", name: "stop-me" });
		await new Promise(r => setTimeout(r, 300));
		const stop = await bgStop(run.details.id);
		await new Promise(r => setTimeout(r, 500));
		const quick = groupAlive(run.details.pid);
		await new Promise(r => setTimeout(r, 5500));
		const afterGrace = groupAlive(run.details.pid);
		result = { stopText: stop.content[0].text, quick, afterGrace };
		`,
		{},
	);
	assert.match(r.stopText, /Stopped background task stop-me/);
	assert.equal(r.afterGrace, false);
});

test("bg_stop on unknown id reports not found", { timeout: 15_000 }, async () => {
	const r = scenario(`const s = await bgStop("deadbeef"); result = { text: s.content[0].text }`, {});
	assert.match(r.text, /No task found/);
});

test("bg_stop is idempotent after exit", { timeout: 15_000 }, async () => {
	const r = scenario(
		`
		const run = await bgRun({ command: "true" });
		${wait(600)}
		const s = await bgStop(run.details.id);
		result = { text: s.content[0].text };
		`,
		{},
	);
	assert.match(r.text, /already /);
});

test("bg_tail returns status of a running task", { timeout: 15_000 }, async () => {
	const r = scenario(
		`
		const run = await bgRun({ command: "sleep 3", name: "slow" });
		const t = await bgTail(run.details.id);
		result = { text: t.content[0].text, idHit: /running since/.test(t.content[0].text) };
		`,
		{},
	);
	assert.match(r.text, /running since/);
});

test("bg_tail works after exit with completion status", { timeout: 15_000 }, async () => {
	const r = scenario(
		`
		const run = await bgRun({ command: "true" });
		${wait(600)}
		const t = await bgTail(run.details.id);
		result = { text: t.content[0].text };
		`,
		{},
	);
	assert.match(r.text, /completed with exit code 0/);
});

test("session_shutdown handler kills all session tasks", { timeout: 15_000 }, async () => {
	const r = scenario(
		`
		const run = await bgRun({ command: "sleep 60", name: "victim" });
		const pid = run.details.pid;
		await new Promise(res => setTimeout(res, 300));
		for (const h of handlers.get("session_shutdown") ?? []) await h();
		await new Promise(res => setTimeout(res, 300));
		result = { alive: groupAlive(pid) };
		`,
		{},
	);
	assert.equal(r.alive, false);
});

test("signal-killed task names the signal instead of 'exit code null'", { timeout: 15_000 }, async () => {
	const r = scenario(
		`
		const run = await bgRun({ command: "sleep 60", name: "killed" });
		await new Promise(res => setTimeout(res, 300));
		for (const h of handlers.get("session_shutdown") ?? []) await h();
		await new Promise(res => setTimeout(res, 500));
		const pushed = sent.find(m => m.customType === "minimal-bg");
		result = { text: pushed?.content ?? null, signal: pushed?.details?.signal ?? null };
		`,
		{},
	);
	assert.match(r.text, /killed by SIGTERM/);
	assert.doesNotMatch(r.text, /exit code null/);
	assert.equal(r.signal, "SIGTERM");
});
test("start message reports the resolved shell and bashisms work", { timeout: 15_000 }, async () => {
	const r = scenario(
		`
		const run = await bgRun({ command: 'declare -A m=([k]=v); echo \${m[k]}', name: "bashism" });
		${wait(600)}
		const tail = await bgTail(run.details.id);
		result = { text: run.content[0].text, shell: run.details.shell, tail: tail.content[0].text };
		`,
		{},
	);
	assert.match(r.text, /shell (bash|\/bin\/sh)/);
	assert.equal(r.shell, "bash");
	assert.match(r.tail, /completed with exit code 0\nv/);
});

test("BG_RUN_SHELL override and missing-shell fallback", { timeout: 15_000 }, async () => {
	const r = scenario(
		`
		const run = await bgRun({ command: "true" });
		result = { text: run.content[0].text };
		`,
		{},
		{ BG_RUN_SHELL: "/nonexistent-shell-for-test" },
	);
	assert.match(r.text, /shell \/bin\/sh\b/);
});

const startSession = (mode: string, sessionKey = "sess-test") =>
	`for (const h of handlers.get("session_start") ?? []) await h({ type: "session_start", reason: "startup" }, { mode: ${JSON.stringify(mode)}, sessionManager: { getSessionId: () => ${JSON.stringify(sessionKey)} } });`;

const shutdownSession = (mode: string) =>
	`for (const h of handlers.get("session_shutdown") ?? []) await h({ type: "session_shutdown", reason: "quit" }, { mode: ${JSON.stringify(mode)} });`;

test("print-mode shutdown keeps the task alive and writes a running ledger", { timeout: 30_000 }, async () => {
	const r = scenario(
		`
		${startSession("print")}
		const run = await bgRun({ command: "sleep 20", name: "svc", timeoutSeconds: 60 });
		await new Promise(res => setTimeout(res, 400));
		${shutdownSession("print")}
		await new Promise(res => setTimeout(res, 400));
		const ledger = JSON.parse(await Bun.file(dir + "/" + run.details.id + ".json").text());
		result = { alive: groupAlive(run.details.pid), status: ledger.status, ownerExitedAt: !!ledger.ownerExitedAt, reapPolicy: ledger.reapPolicy, mode: ledger.mode, text: run.content[0].text };
		`,
		{},
	);
	assert.equal(r.alive, true);
	assert.equal(r.status, "running");
	assert.equal(r.ownerExitedAt, true);
	assert.equal(r.reapPolicy, "deadline");
	assert.equal(r.mode, "print");
	assert.match(r.text, /will not come back to this turn/);
});

test("tui shutdown still uses on-owner-exit policy and kills", { timeout: 30_000 }, async () => {
	const r = scenario(
		`
		${startSession("tui")}
		const run = await bgRun({ command: "sleep 20", name: "tui-svc", timeoutSeconds: 60 });
		await new Promise(res => setTimeout(res, 400));
		${shutdownSession("tui")}
		await new Promise(res => setTimeout(res, 600));
		result = { alive: groupAlive(run.details.pid), text: run.content[0].text };
		`,
		{},
	);
	assert.equal(r.alive, false);
	assert.doesNotMatch(r.text, /will not come back to this turn/);
});

test("next session start reports a task that finished with no session attached", { timeout: 60_000 }, async () => {
	const dir = join(tmpdir(), `bg-test-xproc-${process.pid}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	const first = scenario(
		`
		${startSession("print", "sess-a")}
		const run = await bgRun({ command: "sleep 1; echo done-xproc", name: "xproc", timeoutSeconds: 30 });
		result = { id: run.details.id };
		`,
		{},
		{ BG_RUN_DIR: dir },
	);
	await new Promise((res) => setTimeout(res, 2500));
	const second = scenario(
		`
		${startSession("print", "sess-a")}
		await new Promise(res => setTimeout(res, 300));
		const list = await tools.get("bg_list").execute("call", {});
		result = { pushed: sent.filter(m => /while no session was attached/.test(m.content)).length, listed: list.content[0].text };
		`,
		{},
		{ BG_RUN_DIR: dir },
	);
	assert.equal(second.pushed, 1);
	assert.match(second.listed, new RegExp(first.id));
});

test("session_start reaps on-owner-exit orphans whose owner is gone", { timeout: 30_000 }, async () => {
	const r = scenario(
		`
		const { spawn } = await import("node:child_process");
		const fs = await import("node:fs");
		const proc = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
		const id = "aaaabbbb";
		const ledger = {
			id, name: "orphan", command: "sleep 60", logPath: dir + "/" + id + ".log",
			pid: proc.pid, pgid: proc.pid, startedAt: Date.now(), deadlineAt: Date.now() + 60000, timeoutSeconds: 60,
			mode: "print", sessionKey: "gone", reapPolicy: "on-owner-exit",
			owner: { pid: 4000001, mode: "print", sessionKey: "gone" },
			status: "running", exitCode: null, signal: null, finishedAt: null, notified: false,
		};
		fs.writeFileSync(dir + "/" + id + ".json", JSON.stringify(ledger));
		${startSession("print", "sess-new")}
		await new Promise(res => setTimeout(res, 900));
		const after = JSON.parse(fs.readFileSync(dir + "/" + id + ".json", "utf8"));
		result = { alive: groupAlive(proc.pid), status: after.status };
		`,
		{},
	);
	assert.equal(r.alive, false);
	assert.equal(r.status, "killed");
});

test("bg_tail running text is mode-aware", { timeout: 30_000 }, async () => {
	const tui = scenario(
		`
		${startSession("tui")}
		const run = await bgRun({ command: "sleep 20", timeoutSeconds: 60 });
		await bgTail(run.details.id);
		const t = await bgTail(run.details.id);
		result = { text: t.content[0].text };
		`,
		{},
	);
	assert.match(tui.text, /End your turn/);
	const print = scenario(
		`
		${startSession("print")}
		const run = await bgRun({ command: "sleep 20", timeoutSeconds: 60 });
		await bgTail(run.details.id);
		const t = await bgTail(run.details.id);
		result = { text: t.content[0].text };
		`,
		{},
	);
	assert.doesNotMatch(print.text, /End your turn/);
	assert.match(print.text, /one-shot/);
});
