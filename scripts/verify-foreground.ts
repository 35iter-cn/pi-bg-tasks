import { existsSync, readFileSync } from "node:fs";

type ToolCall = { type: string; name?: string; arguments?: { command?: string } };
type Message = {
	role?: string;
	content?: ToolCall[];
	toolName?: string;
	durationMs?: number;
};

const SESSION = process.argv[2];
if (!SESSION || !existsSync(SESSION)) {
	console.error("usage: bun scripts/verify-foreground.ts <session.jsonl>");
	process.exit(2);
}

const LONG_LIVED =
	/(node\s+[^\s|;&]*\.mjs|node\s+-e[^\n]*createServer|\bvite\b|\bnext\s+dev\b|\bdotnet\s+run\b|\bnpm\s+run\s+dev\b|\btail\s+-f\b|\bhttp\.createServer\b|python3?\s+-m\s+http\.server|\buvicorn\b|\bphp\s+-S\b)/;
const DETACHED = /(\bnohup\b|\btimeout\s+\d|\bbg_run\b)|(^|\s)&\s*$|(^|\s)&\s+(;|$)/;

const violations: string[] = [];

for (const line of readFileSync(SESSION, "utf8").split("\n")) {
	if (!line.trim()) continue;
	let entry: { type?: string; message?: Message };
	try {
		entry = JSON.parse(line);
	} catch {
		continue;
	}
	const message = entry.message;
	if (!message) continue;

	if (message.role === "toolResult" && typeof message.durationMs === "number" && message.durationMs > 60_000) {
		violations.push(`tool ${message.toolName ?? "?"} blocked ${message.durationMs}ms (> 60000)`);
	}

	if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
	const calls = message.content.filter((c) => c.type === "toolCall");
	const foregroundStarts = calls.filter((c) => {
		if (c.name !== "bash") return false;
		const command = String(c.arguments?.command ?? "");
		return LONG_LIVED.test(command) && !DETACHED.test(command);
	});
	for (const call of foregroundStarts) {
		violations.push(`foreground long-lived bash: ${String(call.arguments?.command ?? "").slice(0, 90)}`);
	}
	if (foregroundStarts.length > 0 && calls.length > 1) {
		violations.push(`batch mixes a long-lived start with ${calls.length - 1} other call(s): a batch is serial, the probe never starts`);
	}
}

for (const violation of violations) console.log(`VIOLATION: ${violation}`);
console.log(violations.length === 0 ? "PASS" : `FAIL (${violations.length} violation(s))`);
process.exit(violations.length === 0 ? 0 : 1);
