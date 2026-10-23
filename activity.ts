import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Resolve aliases even before Pi flushes a new session to disk. */
export function canonicalSessionFile(file: string): string {
	try {
		return realpathSync(file);
	} catch {
		return join(realpathSync(dirname(resolve(file))), basename(file));
	}
}

export interface SessionPresence {
	file: string;
	marker: string;
	release(): void;
}

function presenceDir(root: string, file: string): string {
	const key = createHash("sha256").update(canonicalSessionFile(file)).digest("hex");
	return join(root, ".active", key);
}

/** One immutable record per open session, including multiple opens in the same process. */
export function registerSessionPresence(root: string, file: string): SessionPresence {
	const canonical = canonicalSessionFile(file);
	const dir = presenceDir(root, canonical);
	mkdirSync(dir, { recursive: true });
	const marker = join(dir, `${randomUUID()}.json`);
	writeFileSync(marker, JSON.stringify({ pid: process.pid, host: hostname() }), { flag: "wx", mode: 0o600 });
	return {
		file: canonical,
		marker,
		release() {
			try {
				unlinkSync(marker);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		},
	};
}

/**
 * Cooperative guard, NOT an OS session-file lock. Pi processes without this
 * extension (and the interval before session_start) cannot be observed.
 * Never infer inactivity from timestamps, inference events, or an idle timeout.
 */
export function assertSessionNotActive(root: string, file: string, ownMarker?: string): void {
	const dir = presenceDir(root, file);
	let records: string[];
	try {
		records = readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw new Error("Cannot verify session activity; nothing was archived.", { cause: error });
	}
	for (const record of records) {
		const marker = join(dir, record);
		if (marker === ownMarker) continue;
		let owner: { pid: number; host: string };
		try {
			owner = JSON.parse(readFileSync(marker, "utf8"));
			if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.host !== hostname()) {
				throw new Error("Invalid activity record or a session on another host");
			}
		} catch (error) {
			// Another process may have just closed its session.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new Error("Cannot verify session activity; nothing was archived.", { cause: error });
		}
		try {
			process.kill(owner.pid, 0);
		} catch (error) {
			// Only a definitely absent process is inactive. EPERM/unknown means refuse.
			// PID reuse can conservatively block an archive, never permit a live one.
			if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
			throw new Error("Cannot verify session activity; nothing was archived.", { cause: error });
		}
		throw new Error(`Session is open in Pi process ${owner.pid}; close it before archiving.`);
	}
}

// Pi keeps the same SessionManager on /reload. Keep its record across extension
// runtimes, with no unprotected reload gap. Different SDK sessions get separate
// records even when they share a PID. If the extension is removed on reload, the
// record conservatively blocks archives until that process exits.
const STATE = Symbol.for("pi-session-archive.presence.v1");
const globals = globalThis as typeof globalThis & { [STATE]?: WeakMap<object, SessionPresence> };
const presences = globals[STATE] ??= new WeakMap<object, SessionPresence>();

export function trackSession(manager: object, root: string, file: string): SessionPresence {
	const existing = presences.get(manager);
	if (existing?.file === canonicalSessionFile(file)) return existing;
	const presence = registerSessionPresence(root, file);
	existing?.release();
	presences.set(manager, presence);
	return presence;
}

export function untrackSession(manager: object): void {
	presences.get(manager)?.release();
	presences.delete(manager);
}
