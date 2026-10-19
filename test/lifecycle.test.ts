import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import sessionArchive, { appendIfContinuation, cwdDirName } from "../index.ts";

const ID = "01a0aaaa-0000-7000-8000-000000000001";
const FILE = `2026-10-01T10-00-00-000Z_${ID}.jsonl`;
const CWD = "/work/project";

const header = JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-10-01T10:00:00.000Z", cwd: CWD });
const entry = (id: string, parentId: string | null) =>
	JSON.stringify({ type: "message", id, parentId, timestamp: "2026-10-01T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: id }], timestamp: 1 } });

let agentDir: string;
let liveDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-session-archive-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	liveDir = join(agentDir, "sessions", cwdDirName(CWD));
	mkdirSync(liveDir, { recursive: true });
});

function writeLines(path: string, lines: string[]): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${lines.join("\n")}\n`);
}

test("appendIfContinuation appends a headerless tail that hangs off the archived copy", () => {
	const archived = join(agentDir, "archived.jsonl");
	const fragment = join(agentDir, "fragment.jsonl");
	writeLines(archived, [header, entry("a", null)]);
	writeLines(fragment, [entry("b", "a"), entry("c", "b")]);

	assert.equal(appendIfContinuation(fragment, archived), true);
	assert.equal(readFileSync(archived, "utf8"), `${[header, entry("a", null), entry("b", "a"), entry("c", "b")].join("\n")}\n`);
	assert.equal(existsSync(fragment), false);
});

test("appendIfContinuation leaves full sessions and unrelated fragments alone", () => {
	const archived = join(agentDir, "archived.jsonl");
	const withHeader = join(agentDir, "full.jsonl");
	const dangling = join(agentDir, "dangling.jsonl");
	writeLines(archived, [header, entry("a", null)]);
	writeLines(withHeader, [header, entry("a", null), entry("b", "a")]);
	writeLines(dangling, [entry("b", "a"), entry("c", "zzz")]);

	assert.equal(appendIfContinuation(withHeader, archived), false);
	assert.equal(appendIfContinuation(dangling, archived), false);
	assert.ok(existsSync(withHeader));
	assert.ok(existsSync(dangling));
});

type Handler = (event: unknown, ctx: unknown) => void;

function loadExtension(sessionName: string) {
	const handlers = new Map<string, Handler>();
	const pi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		getSessionName: () => sessionName,
		setSessionName: () => {},
	};
	sessionArchive(pi as unknown as Parameters<typeof sessionArchive>[0]);
	const file = join(liveDir, FILE);
	const ctx = { sessionManager: { getSessionFile: () => file, getCwd: () => CWD } };
	handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
	return {
		file,
		shutdown: (event: Record<string, unknown>) => handlers.get("session_shutdown")?.({ type: "session_shutdown", ...event }, ctx),
	};
}

test("a tagged session survives a reload in place", () => {
	const { file, shutdown } = loadExtension("[ARCHIVE] done");
	writeLines(file, [header, entry("a", null)]);

	shutdown({ reason: "reload" });

	assert.ok(existsSync(file));
	assert.equal(existsSync(join(agentDir, "sessions-archive", "index.json")), false);
});

test("quitting a tagged session archives it", () => {
	const { file, shutdown } = loadExtension("[ARCHIVE] done");
	writeLines(file, [header, entry("a", null)]);

	shutdown({ reason: "quit" });

	assert.equal(existsSync(file), false);
	assert.ok(existsSync(join(agentDir, "sessions-archive", cwdDirName(CWD), FILE)));
	const index = JSON.parse(readFileSync(join(agentDir, "sessions-archive", "index.json"), "utf8"));
	assert.deepEqual(Object.keys(index), [join(cwdDirName(CWD), FILE)]);
	assert.equal(index[join(cwdDirName(CWD), FILE)].name, "done");
});

test("quitting merges a leftover tail into the archived copy instead of superseding it", () => {
	const { file, shutdown } = loadExtension("[ARCHIVE] done");
	const archived = join(agentDir, "sessions-archive", cwdDirName(CWD), FILE);
	writeLines(archived, [header, entry("a", null)]);
	writeLines(file, [entry("b", "a")]);

	shutdown({ reason: "quit" });

	assert.equal(existsSync(file), false);
	assert.equal(readFileSync(archived, "utf8"), `${[header, entry("a", null), entry("b", "a")].join("\n")}\n`);
});

test("an untagged session is never archived", () => {
	const { file, shutdown } = loadExtension("still working");
	writeLines(file, [header, entry("a", null)]);

	shutdown({ reason: "quit" });

	assert.ok(existsSync(file));
});
