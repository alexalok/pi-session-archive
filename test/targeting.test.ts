import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import sessionArchive, { cwdDirName, restoreArchived } from "../index.ts";
import { registerSessionPresence } from "../activity.ts";

const CURRENT = "01a0aaaa-0000-7000-8000-000000000001";
const OTHER = "01a0bbbb-0000-7000-8000-000000000002";
const CWD = "/work/project";
let root: string;
let oldAgentDir: string | undefined;

beforeEach(() => {
	oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	root = mkdtempSync(join(tmpdir(), "pi-archive-targeting-"));
	process.env.PI_CODING_AGENT_DIR = root;
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
});

function seed(id = OTHER, cwd = CWD, name = "Finished work", dir = join(root, "sessions", cwdDirName(cwd))): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-10-01T10-00-00-000Z_${id}.jsonl`);
	writeFileSync(file, [
		{ type: "session", version: 3, id, cwd, timestamp: "2026-10-01T10:00:00.000Z" },
		{ type: "session_info", id: "n", parentId: null, timestamp: "2026-10-01T10:00:01.000Z", name },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return file;
}

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

function load(file = seed(CURRENT), id = CURRENT, manager?: ExtensionContext["sessionManager"], initialName = "Current chat") {
	const commands = new Map<string, Command>();
	const handlers = new Map<string, Handler>();
	let tool: Tool;
	let name = initialName;
	const notices: { text: string; type?: string }[] = [];
	const ctx = {
		cwd: CWD,
		sessionManager: manager ?? {
			getSessionFile: () => file,
			getSessionId: () => id,
			getSessionDir: () => dirname(file),
			getCwd: () => CWD,
		},
		ui: { notify: (text: string, type?: string) => notices.push({ text, type }) },
	} as unknown as ExtensionContext;
	const pi = {
		registerCommand: (key: string, command: Command) => commands.set(key, command),
		registerTool: (registered: Tool) => { tool = registered; },
		on: (key: string, handler: Handler) => handlers.set(key, handler),
		getSessionName: () => name,
		setSessionName: (value: string) => { name = value; },
	} as unknown as ExtensionAPI;
	sessionArchive(pi);
	const emit = (event: string, reason: string) => handlers.get(event)?.({ type: event, reason }, ctx);
	emit("session_start", "startup");
	return {
		ctx, file, notices, emit,
		name: () => name,
		schema: () => tool.parameters,
		command: (args: string) => commands.get("archive")!.handler(args, ctx as Parameters<Command["handler"]>[1]),
		archive: (sessionId?: string, signal?: AbortSignal) => tool.execute("test", sessionId === undefined ? {} : { sessionId }, signal, undefined, ctx as Parameters<Tool["execute"]>[4]),
	};
}

function archived(file: string, cwd = CWD): string {
	return join(root, "sessions-archive", cwdDirName(cwd), basename(file));
}

test("the agent tool accepts only an optional sessionId", () => {
	const session = load();
	const schema = JSON.parse(JSON.stringify(session.schema()));
	assert.deepEqual(Object.keys(schema.properties), ["sessionId"]);
	assert.equal(schema.additionalProperties, false);
});

test("the agent archives another exact ID, preserving its contents, name, and companions", async () => {
	const file = seed();
	const before = readFileSync(file, "utf8");
	const companion = file.slice(0, -".jsonl".length);
	mkdirSync(companion);
	writeFileSync(join(companion, "artifact.txt"), "keep me");
	const current = load();

	await current.archive(OTHER);

	assert.equal(existsSync(file), false);
	assert.equal(readFileSync(archived(file), "utf8"), before);
	assert.equal(readFileSync(join(archived(file).slice(0, -6), "artifact.txt"), "utf8"), "keep me");
	assert.equal(current.name(), "Current chat");
	assert.ok(existsSync(current.file));
	const index = JSON.parse(readFileSync(join(root, "sessions-archive", "index.json"), "utf8"));
	assert.equal(Object.values<{ name: string }>(index)[0].name, "Finished work");
});

test("an exact-ID archive restored with keep-archived returns to the archive on close", async () => {
	const file = seed();
	const before = readFileSync(file, "utf8");
	await load().archive(OTHER);
	const restored = restoreArchived(archived(file), dirname(file), true);
	assert.ok(readFileSync(restored, "utf8").startsWith(before));
	const manager = SessionManager.open(restored);
	assert.equal(manager.getSessionName(), "[ARCHIVE] Finished work");
	const resumed = load(restored, OTHER, manager, manager.getSessionName());
	resumed.emit("session_shutdown", "quit");
	assert.equal(existsSync(restored), false);
	assert.ok(existsSync(archived(file)));
});

test("/archive ID finds sessions in a different working directory", async () => {
	const cwd = "/another/project";
	const file = seed(OTHER, cwd);
	await load().command(OTHER);
	assert.equal(existsSync(file), false);
	assert.ok(existsSync(archived(file, cwd)));
});

test("lookup includes the current custom session directory", async () => {
	const dir = join(root, "custom-sessions");
	const current = load(seed(CURRENT, CWD, "Current", dir));
	const file = seed(OTHER, CWD, "Other", dir);
	await current.archive(OTHER);
	assert.ok(existsSync(archived(file)));
});

test("custom session IDs, including underscores, retain their companions", async () => {
	const id = "custom_session.42";
	const file = seed(id);
	const artifact = join(".pi-agent-browser-artifacts", id, "shot.png");
	mkdirSync(dirname(join(dirname(file), artifact)), { recursive: true });
	writeFileSync(join(dirname(file), artifact), "screenshot");
	await load().archive(id);
	assert.ok(existsSync(archived(file)));
	assert.equal(readFileSync(join(dirname(archived(file)), artifact), "utf8"), "screenshot");
});

for (const target of [undefined, CURRENT]) {
	test(`current-session archiving stays deferred (${target ?? "no argument"})`, async () => {
		const current = load();
		await current.archive(target);
		assert.equal(current.name(), "[ARCHIVE] Current chat");
		assert.ok(existsSync(current.file));
		current.emit("session_shutdown", "reload");
		assert.ok(existsSync(current.file));
		current.emit("session_shutdown", "quit");
		assert.equal(existsSync(current.file), false);
		assert.ok(existsSync(archived(current.file)));
	});
}

for (const target of ["Finished work", "Finished-work", OTHER.slice(0, 8), "/tmp/session.jsonl", "../session", `${OTHER} ${CURRENT}`, "missing-id", ""]) {
	test(`the tool refuses non-ID or missing target ${JSON.stringify(target)} without tagging the current chat`, async () => {
		const file = seed(OTHER, CWD, "Finished-work");
		const current = load();
		await assert.rejects(current.archive(target), /complete session ID|exact ID/);
		assert.ok(existsSync(file));
		assert.equal(current.name(), "Current chat");
	});
}

test("a command error is shown to the user and does not archive anything", async () => {
	const current = load();
	await current.command("missing-id");
	assert.equal(current.notices.at(-1)?.type, "error");
	assert.match(current.notices.at(-1)!.text, /exact ID/);
	assert.equal(current.name(), "Current chat");
});

test("duplicate exact IDs are refused, not selected arbitrarily", async () => {
	const first = seed(OTHER);
	const second = seed(OTHER, "/other/project");
	await assert.rejects(load().archive(OTHER), /Multiple session files/);
	assert.ok(existsSync(first));
	assert.ok(existsSync(second));
});

test("an ID shared by the current chat and another file is refused", async () => {
	const current = load();
	const duplicate = seed(CURRENT, "/other/project");
	await assert.rejects(current.archive(CURRENT), /Multiple session files/);
	assert.ok(existsSync(duplicate));
	assert.equal(current.name(), "Current chat");
});

test("the current ID can be targeted before its first disk flush", async () => {
	const current = load();
	rmSync(current.file);
	await current.archive(CURRENT);
	assert.equal(current.name(), "[ARCHIVE] Current chat");
});

test("cancellation during discovery prevents any archive", async () => {
	const file = seed();
	const current = load();
	const controller = new AbortController();
	const operation = current.archive(OTHER, controller.signal);
	controller.abort();
	await assert.rejects(operation, { name: "AbortError" });
	assert.ok(existsSync(file));
	assert.equal(current.name(), "Current chat");
});

test("a session opened during discovery is checked before the move", async () => {
	const file = seed();
	const current = load();
	const operation = current.archive(OTHER);
	const presence = registerSessionPresence(join(root, "sessions-archive"), file);
	await assert.rejects(operation, /Session is open/);
	assert.ok(existsSync(file));
	presence.release();
});

test("an existing archive is not overwritten by explicit targeting", async () => {
	const file = seed();
	mkdirSync(dirname(archived(file)), { recursive: true });
	writeFileSync(archived(file), "existing archive\n");
	await assert.rejects(load().archive(OTHER), /archived copy already exists/);
	assert.ok(existsSync(file));
	assert.equal(readFileSync(archived(file), "utf8"), "existing archive\n");
});

test("another open but idle session is refused; closing it allows archiving", async () => {
	const file = seed();
	const other = load(file, OTHER);
	const current = load();
	await assert.rejects(current.archive(OTHER), /Session is open/);
	assert.ok(existsSync(file));
	other.emit("session_shutdown", "quit");
	await current.archive(OTHER);
	assert.ok(existsSync(archived(file)));
});

test("the activity record survives /reload and is reused by the new runtime", async () => {
	const file = seed();
	const other = load(file, OTHER);
	const current = load();
	other.emit("session_shutdown", "reload");
	await assert.rejects(current.archive(OTHER), /Session is open/);
	const reloaded = load(file, OTHER, other.ctx.sessionManager);
	await assert.rejects(current.archive(OTHER), /Session is open/);
	reloaded.emit("session_shutdown", "quit");
	await current.archive(OTHER);
	assert.ok(existsSync(archived(file)));
});

test("closing one of two readers in the same process does not clear the other's protection", async () => {
	const file = seed();
	const first = load(file, OTHER);
	const second = load(file, OTHER);
	const current = load();
	first.emit("session_shutdown", "quit");
	await assert.rejects(current.archive(OTHER), /Session is open/);
	second.emit("session_shutdown", "quit");
	await current.archive(OTHER);
});

test("archive-on-close also refuses to move a transcript open elsewhere", async () => {
	const current = load();
	const reader = registerSessionPresence(join(root, "sessions-archive"), current.file);
	await current.archive();
	assert.throws(() => current.emit("session_shutdown", "quit"), /Session is open/);
	assert.ok(existsSync(current.file));
	reader.release();
});

test("a real live process blocks archiving, then its stale record is ignored after exit", { timeout: 15_000 }, async () => {
	const file = seed();
	const child = fork(new URL("./presence-fixture.ts", import.meta.url), [root, file], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
	try {
		const [message] = await once(child, "message");
		assert.equal(message, "ready");
		const current = load();
		await assert.rejects(current.archive(OTHER), new RegExp(`process ${child.pid}`));
		assert.ok(existsSync(file));
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		await current.archive(OTHER);
		assert.ok(existsSync(archived(file)));
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
});
