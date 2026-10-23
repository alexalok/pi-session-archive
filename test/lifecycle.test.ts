import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import sessionArchive, {
	appendIfContinuation,
	cwdDirName,
	findCompanions,
	moveCompanions,
	sessionIdFromFile,
} from "../index.ts";

const ID = "01a0aaaa-0000-7000-8000-000000000001";
const OTHER_ID = "01a0bbbb-0000-7000-8000-000000000002";
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

function seedCompanions(dir: string): void {
	writeLines(join(dir, FILE.replace(".jsonl", ""), "run-0", "session.jsonl"), [header]);
	writeLines(join(dir, ".pi-agent-browser-artifacts", ID, "shot.png"), ["png"]);
	writeLines(join(dir, "subagent-artifacts", "run1_reviewer_meta.json"), [JSON.stringify({ parentSessionId: ID })]);
	writeLines(join(dir, "subagent-artifacts", "run1_reviewer_output.md"), ["out"]);
	writeLines(join(dir, "subagent-artifacts", "run2_reviewer_meta.json"), [JSON.stringify({ parentSessionId: OTHER_ID })]);
	writeLines(join(dir, "subagent-artifacts", "run2_reviewer_output.md"), ["out"]);
}

test("sessionIdFromFile reads the id after the timestamp", () => {
	assert.equal(sessionIdFromFile(`/x/${FILE}`), ID);
});

test("findCompanions lists the session dir, its screenshots, and only its own subagent runs", () => {
	seedCompanions(liveDir);
	assert.deepEqual(findCompanions(liveDir, FILE).sort(), [
		".pi-agent-browser-artifacts/" + ID,
		FILE.replace(".jsonl", ""),
		"subagent-artifacts/run1_reviewer_meta.json",
		"subagent-artifacts/run1_reviewer_output.md",
	]);
});

test("moveCompanions moves companions and never overwrites an existing destination", () => {
	seedCompanions(liveDir);
	const archiveDir = join(agentDir, "sessions-archive", cwdDirName(CWD));
	writeLines(join(archiveDir, "subagent-artifacts", "run1_reviewer_output.md"), ["already archived"]);

	moveCompanions(liveDir, archiveDir, FILE);

	assert.ok(existsSync(join(archiveDir, FILE.replace(".jsonl", ""), "run-0", "session.jsonl")));
	assert.ok(existsSync(join(archiveDir, ".pi-agent-browser-artifacts", ID, "shot.png")));
	assert.ok(existsSync(join(archiveDir, "subagent-artifacts", "run1_reviewer_meta.json")));
	assert.equal(readFileSync(join(archiveDir, "subagent-artifacts", "run1_reviewer_output.md"), "utf8"), "already archived\n");
	assert.ok(existsSync(join(liveDir, "subagent-artifacts", "run1_reviewer_output.md")));
	assert.ok(existsSync(join(liveDir, "subagent-artifacts", "run2_reviewer_meta.json")));
});

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
type Command = { handler: (args: string, ctx: unknown) => Promise<void> };

function lastSessionName(file: string): string {
	if (!existsSync(file)) return "";
	const names = readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.includes('"type":"session_info"'))
		.map((line) => JSON.parse(line).name as string);
	return names.at(-1) ?? "";
}

function loadExtension(sessionName: string | (() => string)) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const pi = {
		registerTool: () => {},
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		getSessionName: typeof sessionName === "string" ? () => sessionName : sessionName,
		setSessionName: () => {},
	};
	sessionArchive(pi as unknown as Parameters<typeof sessionArchive>[0]);
	const file = join(liveDir, FILE);
	const ctx = { sessionManager: { getSessionFile: () => file, getCwd: () => CWD } };
	const start = () => handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
	start();
	return {
		file,
		start,
		shutdown: (event: Record<string, unknown>) => handlers.get("session_shutdown")?.({ type: "session_shutdown", ...event }, ctx),
		commands,
	};
}

test("a tagged session survives a reload in place", () => {
	const { file, shutdown } = loadExtension("[ARCHIVE] done");
	writeLines(file, [header, entry("a", null)]);
	seedCompanions(liveDir);

	shutdown({ reason: "reload" });

	assert.ok(existsSync(file));
	assert.ok(existsSync(join(liveDir, FILE.replace(".jsonl", ""))));
	assert.equal(existsSync(join(agentDir, "sessions-archive", "index.json")), false);
});

test("quitting a tagged session archives its file and its companions", () => {
	const { file, shutdown } = loadExtension("[ARCHIVE] done");
	writeLines(file, [header, entry("a", null)]);
	seedCompanions(liveDir);

	shutdown({ reason: "quit" });

	const archiveDir = join(agentDir, "sessions-archive", cwdDirName(CWD));
	assert.equal(existsSync(file), false);
	assert.ok(existsSync(join(archiveDir, FILE)));
	assert.ok(existsSync(join(archiveDir, FILE.replace(".jsonl", ""), "run-0", "session.jsonl")));
	assert.ok(existsSync(join(archiveDir, ".pi-agent-browser-artifacts", ID)));
	assert.ok(existsSync(join(archiveDir, "subagent-artifacts", "run1_reviewer_output.md")));
	assert.ok(existsSync(join(liveDir, "subagent-artifacts", "run2_reviewer_output.md")));
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

const archiveDir = () => join(agentDir, "sessions-archive", cwdDirName(CWD));
const archivedFile = () => join(archiveDir(), FILE);
const indexFile = () => join(agentDir, "sessions-archive", "index.json");

function seedArchive(name: string | null = "[ARCHIVE] done"): void {
	writeLines(archivedFile(), [
		header,
		entry("a", null),
		...(name === null ? [] : [JSON.stringify({ type: "session_info", id: "n", parentId: "a", timestamp: "t", name })]),
	]);
	seedCompanions(archiveDir());
	writeFileSync(indexFile(), JSON.stringify({ [join(cwdDirName(CWD), FILE)]: { name: "done", cwd: CWD, archivedAt: "t" } }));
}

/** Runs /archives in non-TUI mode: picks the first archived session, then answers the action prompt. */
async function runArchives(answer: string | undefined) {
	const { commands, file, start, shutdown } = loadExtension(() => lastSessionName(join(liveDir, FILE)));
	const prompts: string[][] = [];
	const switched: string[] = [];
	const ui = {
		notify: () => {},
		select: async (_title: string, options: string[]) => {
			prompts.push(options);
			return prompts.length === 1 ? options[0] : answer;
		},
	};
	await commands.get("archives")?.handler("", { mode: "rpc", cwd: CWD, ui, switchSession: async (target: string) => switched.push(target) });
	return { file, start, shutdown, prompts, switched };
}

test("/archives offers the four restore actions", async () => {
	seedArchive();
	const { prompts } = await runArchives("Cancel");
	assert.deepEqual(prompts[1], ["Restore and resume", "Resume, keep archived", "Restore only", "Cancel"]);
});

for (const answer of ["Cancel", undefined]) {
	test(`/archives leaves everything in the archive on ${answer ?? "Esc"}`, async () => {
		seedArchive();
		const { file, switched } = await runArchives(answer);
		assert.ok(existsSync(archivedFile()));
		assert.ok(existsSync(join(archiveDir(), FILE.replace(".jsonl", ""))));
		assert.equal(existsSync(file), false);
		assert.deepEqual(switched, []);
		assert.equal(Object.keys(JSON.parse(readFileSync(indexFile(), "utf8"))).length, 1);
	});
}

test("Restore and resume brings the companions back, drops the tag, and stays live on close", async () => {
	seedArchive();
	const { file, start, shutdown, switched } = await runArchives("Restore and resume");

	assert.deepEqual(switched, [file]);
	assert.equal(lastSessionName(file), "done");
	assert.ok(existsSync(join(liveDir, FILE.replace(".jsonl", ""), "run-0", "session.jsonl")));
	assert.ok(existsSync(join(liveDir, "subagent-artifacts", "run1_reviewer_output.md")));
	assert.deepEqual(JSON.parse(readFileSync(indexFile(), "utf8")), {});

	start();
	shutdown({ reason: "quit" });
	assert.ok(existsSync(file));
});

test("Resume, keep archived keeps the tag, so closing sends the session back to the archive", async () => {
	seedArchive();
	const { file, start, shutdown, switched } = await runArchives("Resume, keep archived");

	assert.deepEqual(switched, [file]);
	assert.equal(lastSessionName(file), "[ARCHIVE] done");

	start();
	shutdown({ reason: "quit" });
	assert.equal(existsSync(file), false);
	assert.ok(existsSync(archivedFile()));
	assert.ok(existsSync(join(archiveDir(), FILE.replace(".jsonl", ""), "run-0", "session.jsonl")));
	assert.ok(existsSync(join(archiveDir(), "subagent-artifacts", "run1_reviewer_output.md")));
});

for (const name of ["done", 'quoted "name"', null, "[ARCHIVE]"]) {
	test(`Resume, keep archived adds a durable tag to ${JSON.stringify(name)} and re-archives on close`, async () => {
		// Exact-ID archiving preserves the transcript, so archives can be untagged
		// or have no session_info at all, unlike the original self-archive path.
		seedArchive(name);
		const { file, start, shutdown, switched } = await runArchives("Resume, keep archived");
		assert.deepEqual(switched, [file]);
		assert.equal(lastSessionName(file), `[ARCHIVE] ${name === null || name === "[ARCHIVE]" ? "(unnamed)" : name}`);
		assert.ok(readFileSync(file, "utf8").includes(entry("a", null)));

		start();
		shutdown({ reason: "quit" });
		assert.equal(existsSync(file), false);
		assert.ok(existsSync(archivedFile()));
	});
}

for (const action of ["Restore and resume", "Restore only"]) {
	test(`${action} leaves an exact-ID archive untagged`, async () => {
		seedArchive("done");
		const { file, start, shutdown } = await runArchives(action);
		assert.equal(lastSessionName(file), "done");
		start();
		shutdown({ reason: "quit" });
		assert.ok(existsSync(file));
	});
}

test("Restore only drops the tag without switching", async () => {
	seedArchive();
	const { file, switched } = await runArchives("Restore only");

	assert.deepEqual(switched, []);
	assert.ok(existsSync(file));
	assert.equal(lastSessionName(file), "done");
	assert.ok(existsSync(join(liveDir, ".pi-agent-browser-artifacts", ID)));
});

test("a live copy only offers to resume it or cancel, and Cancel moves nothing", async () => {
	seedArchive();
	writeLines(join(liveDir, FILE), [header, entry("a", null)]);
	const { prompts, switched } = await runArchives("Cancel");

	assert.deepEqual(prompts[1], ["Resume the live copy", "Cancel"]);
	assert.deepEqual(switched, []);
	assert.ok(existsSync(archivedFile()));
});
