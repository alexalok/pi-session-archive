import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";

import { movePath } from "../file-move.ts";

let root: string;
let source: string;
let target: string;

beforeEach(() => {
	root = fs.mkdtempSync(join(tmpdir(), "pi-archive-move-"));
	source = join(root, "source");
	target = join(root, "target");
	fs.writeFileSync(source, "complete source", { mode: 0o600 });
});
afterEach(() => {
	mock.restoreAll();
	fs.rmSync(root, { recursive: true, force: true });
});

function error(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

function forceCrossDevice(publishError?: string): void {
	const rename = fs.renameSync;
	mock.method(fs, "renameSync", (from: string, to: string) => {
		if (from === source) throw error("EXDEV");
		if (publishError) throw error(publishError);
		rename(from, to);
	});
}

function assertNoStaging(): void {
	assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".session-archive-move-")), false);
}

test("same-filesystem moves use rename without copying", () => {
	mock.method(fs, "cpSync", () => { throw new Error("unexpected copy"); });
	movePath(source, target);
	assert.equal(fs.readFileSync(target, "utf8"), "complete source");
	assert.equal(fs.existsSync(source), false);
	assertNoStaging();
});

test("EXDEV stages a complete file and preserves its permissions and timestamp", () => {
	const timestamp = new Date("2026-01-01T00:00:00Z");
	fs.utimesSync(source, timestamp, timestamp);
	const mode = fs.statSync(source).mode;
	forceCrossDevice();
	movePath(source, target);
	assert.equal(fs.readFileSync(target, "utf8"), "complete source");
	assert.equal(fs.statSync(target).mode, mode);
	assert.equal(fs.statSync(target).mtimeMs, timestamp.getTime());
	assert.equal(fs.existsSync(source), false);
	assertNoStaging();
});

test("EXDEV moves nested and empty directories without following symlinks", () => {
	fs.rmSync(source);
	fs.mkdirSync(join(source, "nested"), { recursive: true });
	fs.mkdirSync(join(source, "empty"));
	fs.writeFileSync(join(source, "nested", "value.txt"), "nested content");
	if (process.platform !== "win32") fs.symlinkSync("nested/value.txt", join(source, "link"));
	forceCrossDevice();
	movePath(source, target);
	assert.equal(fs.readFileSync(join(target, "nested", "value.txt"), "utf8"), "nested content");
	assert.ok(fs.statSync(join(target, "empty")).isDirectory());
	if (process.platform !== "win32") {
		assert.ok(fs.lstatSync(join(target, "link")).isSymbolicLink());
		assert.equal(fs.readlinkSync(join(target, "link")), "nested/value.txt");
	}
	assert.equal(fs.existsSync(source), false);
	assertNoStaging();
});

test("non-EXDEV rename errors do not trigger a copy or delete anything", () => {
	mock.method(fs, "renameSync", () => { throw error("EACCES"); });
	mock.method(fs, "cpSync", () => { throw new Error("unexpected copy"); });
	assert.throws(() => movePath(source, target), { code: "EACCES" });
	assert.equal(fs.readFileSync(source, "utf8"), "complete source");
	assert.equal(fs.existsSync(target), false);
	assertNoStaging();
});

test("a failed copy removes partial staging data but preserves source and existing destination", () => {
	fs.writeFileSync(target, "existing target");
	forceCrossDevice();
	mock.method(fs, "cpSync", (_from: string, to: string) => {
		fs.writeFileSync(to, "partial copy");
		throw error("ENOSPC");
	});
	assert.throws(() => movePath(source, target), { code: "ENOSPC" });
	assert.equal(fs.readFileSync(source, "utf8"), "complete source");
	assert.equal(fs.readFileSync(target, "utf8"), "existing target");
	assertNoStaging();
});

test("failed publication keeps the source and does not expose the staged copy", () => {
	forceCrossDevice("EACCES");
	assert.throws(() => movePath(source, target), { code: "EACCES" });
	assert.equal(fs.readFileSync(source, "utf8"), "complete source");
	assert.equal(fs.existsSync(target), false);
	assertNoStaging();
});

test("source cleanup failure leaves both complete copies rather than losing data", () => {
	forceCrossDevice();
	const remove = fs.rmSync;
	mock.method(fs, "rmSync", (path: string, options: fs.RmOptions) => {
		if (path === source) throw error("EPERM");
		remove(path, options);
	});
	assert.throws(() => movePath(source, target), { code: "EPERM" });
	assert.equal(fs.readFileSync(source, "utf8"), "complete source");
	assert.equal(fs.readFileSync(target, "utf8"), "complete source");
	assertNoStaging();
});
