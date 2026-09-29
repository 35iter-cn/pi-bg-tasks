import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
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
function scenario(body: string, out: object) {
	writeFileSync(
		LOADER,
		`
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
	const run = spawnSync("bun", [LOADER], { encoding: "utf8", timeout: 30_000 });
	if (run.status !== 0) throw new Error(`scenario failed: ${run.stderr}`);
	const dumped = JSON.parse(readFileSync(OUT, "utf8"));
	rmSync(OUT, { force: true });
	return dumped;
}

const wait = (ms: number) => `await new Promise(r => setTimeout(r, ${ms}));`;

test("registers three tools and two lifecycle handlers", () => {
	const r = scenario(`result = { tools: [...tools.keys()].sort(), hasStart: handlers.has("session_start"), hasShutdown: handlers.has("session_shutdown") }`, {});
	assert.deepEqual(r.tools, ["bg_run", "bg_stop", "bg_tail"]);
	assert.equal(r.hasStart, true);
	assert.equal(r.hasShutdown, true);
});

test("service timeout hint present in bg_run description and schema", () => {
	const r = scenario(
		`result = { desc: tools.get("bg_run").description, schema: tools.get("bg_run").parameters.properties.timeoutSeconds.description }`,
		{},
	);
	assert.match(r.desc, /long-running services \(dev servers, watchers\)/);
	assert.match(r.schema, /86400/);
	assert.match(r.schema, /long-running services/);
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