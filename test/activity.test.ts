import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";

import { assertSessionNotActive, registerSessionPresence } from "../activity.ts";

let root: string;
let file: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-archive-activity-"));
	file = join(root, "session.jsonl");
	writeFileSync(file, "test");
});
afterEach(() => {
	mock.restoreAll();
	rmSync(root, { recursive: true, force: true });
});

test("an untracked session has no reported activity", () => {
	assert.doesNotThrow(() => assertSessionNotActive(root, file));
});

test("an old record for a live process still protects an idle session", () => {
	const presence = registerSessionPresence(root, file);
	utimesSync(presence.marker, new Date(0), new Date(0));
	assert.throws(() => assertSessionNotActive(root, file), /Session is open/);
});

test("own record can be excluded on shutdown without excluding another reader", () => {
	const first = registerSessionPresence(root, file);
	assert.doesNotThrow(() => assertSessionNotActive(root, file, first.marker));
	const second = registerSessionPresence(root, file);
	assert.throws(() => assertSessionNotActive(root, file, first.marker), /Session is open/);
	second.release();
	first.release();
	first.release();
	assert.doesNotThrow(() => assertSessionNotActive(root, file));
});

for (const data of ["{", "null", "{}", JSON.stringify({ pid: 0, host: hostname() }), JSON.stringify({ pid: process.pid, host: "another-host" })]) {
	test(`unverifiable record blocks archiving (${data})`, () => {
		const presence = registerSessionPresence(root, file);
		writeFileSync(presence.marker, data);
		assert.throws(() => assertSessionNotActive(root, file), /Cannot verify session activity/);
	});
}

test("an unreadable activity directory fails closed", () => {
	writeFileSync(join(root, ".active"), "not a directory");
	assert.throws(() => assertSessionNotActive(root, file), /Cannot verify session activity/);
});

for (const code of ["EPERM", "EACCES", "UNKNOWN"]) {
	test(`PID probe error ${code} fails closed`, () => {
		registerSessionPresence(root, file);
		mock.method(process, "kill", () => { throw Object.assign(new Error(code), { code }); });
		assert.throws(() => assertSessionNotActive(root, file), /Cannot verify session activity/);
	});
}

test("only ESRCH identifies an exited process", () => {
	registerSessionPresence(root, file);
	mock.method(process, "kill", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
	assert.doesNotThrow(() => assertSessionNotActive(root, file));
});

test("directory aliases resolve to the same activity records, including before first flush", { skip: process.platform === "win32" }, () => {
	const dir = join(root, "real");
	const alias = join(root, "alias");
	mkdirSync(dir);
	symlinkSync(dir, alias, "dir");
	const futureFile = join(dir, "future.jsonl");
	registerSessionPresence(root, join(alias, "future.jsonl"));
	writeFileSync(futureFile, "flushed");
	assert.throws(() => assertSessionNotActive(root, futureFile), /Session is open/);
});
