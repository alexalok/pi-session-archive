/**
 * Archive sessions out of /resume. A tool the agent calls when the user wraps
 * up ("we're done with this session"), a /archive command, and /archives to
 * browse and resume archived sessions. The session file only leaves pi's
 * sessions tree when the session closes, so nothing is pulled from under the
 * session manager; the [ARCHIVE] tag in the name is the durable marker.
 *
 * archive/index.json maps each archived file to the name it had at archive
 * time plus its archive date (session names usually live near the head of the
 * file, unreachable from a tail scan); stat mtime is the fallback for both.
 *
 * The /archives picker is a custom TUI component (SelectList based, so it
 * scrolls) with type-to-filter, a current-cwd/all scope toggle (tab, like
 * /resume) and a date/name sort toggle (ctrl+s, like /resume's sort toggle).
 */
import {
	DynamicBorder,
	getAgentDir,
	getSelectListTheme,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionInfo,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type Component,
	type KeybindingsManager,
	Input,
	type SelectItem,
	SelectList,
	Text,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	assertSessionNotActive,
	canonicalSessionFile,
	trackSession,
	untrackSession,
	type SessionPresence,
} from "./activity.ts";

const ARCHIVE_TAG = "[ARCHIVE] ";
const RESTORE_AND_RESUME = "Restore and resume";
const RESUME_KEEP_ARCHIVED = "Resume, keep archived";
const RESTORE_ONLY = "Restore only";
const RESUME_LIVE_COPY = "Resume the live copy";
const CANCEL = "Cancel";
const MAX_VISIBLE = 12;

type Scope = "current" | "all";
type SortMode = "date" | "name";

interface IndexEntry {
	name: string;
	cwd: string;
	archivedAt: string;
}

function archiveRoot(): string {
	return join(getAgentDir(), "sessions-archive");
}

function indexPath(): string {
	return join(archiveRoot(), "index.json");
}

function readIndex(): Record<string, IndexEntry> {
	try {
		return JSON.parse(readFileSync(indexPath(), "utf8"));
	} catch {
		return {};
	}
}

function writeIndex(entries: Record<string, IndexEntry>): void {
	writeFileSync(indexPath(), JSON.stringify(entries, null, "\t"));
}

// Same encoding pi uses for per-cwd session subdirectories.
export function cwdDirName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function tagged(name: string | undefined): string {
	const base = name?.startsWith(ARCHIVE_TAG) ? name.slice(ARCHIVE_TAG.length) : name ?? "";
	return `${ARCHIVE_TAG}${base}`.trim();
}

/** First JSONL line holds the session header, including the cwd it was born in. */
function headerCwd(file: string): string | undefined {
	try {
		const firstLine = readFileSync(file, "utf8").slice(0, 4096).split("\n")[0];
		const header = JSON.parse(firstLine);
		return typeof header?.cwd === "string" ? header.cwd : undefined;
	} catch {
		return undefined;
	}
}

export function cleanName(name: string | undefined): string {
	const cleaned = (name ?? "").replaceAll(ARCHIVE_TAG, "").trim();
	return (cleaned || "(unnamed)").replace(/^["']|["']$/g, "");
}

function normalizeCwd(cwd: string): string {
	return resolve(cwd);
}

export function relativeTime(date: Date): string {
	const sec = Math.floor((Date.now() - date.getTime()) / 1000);
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	return `${Math.floor(hr / 24)}d ago`;
}

/**
 * Strip the [ARCHIVE] tag from the last session_info name, editing the file
 * in place (temp file + rename so a crash cannot truncate it). Restoring
 * needs this: a restored file that keeps the tag would be re-archived on its
 * next close by the self-heal logic. Best effort; the move already succeeded.
 */
function stripTagInFile(file: string): void {
	try {
		const lines = readFileSync(file, "utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (!line.includes('"type":"session_info"')) continue;
			const match = line.match(/"name":"((?:[^"\\]|\\.)*)"/);
			if (!match) return;
			const decoded = JSON.parse(`"${match[1]}"`);
			if (!decoded.startsWith(ARCHIVE_TAG)) return;
			const stripped = JSON.stringify(decoded.slice(ARCHIVE_TAG.length)).slice(1, -1);
			lines[i] = line.replace(`"name":"${match[1]}"`, `"name":"${stripped}"`);
			const tmp = `${file}.session-archive-tmp`;
			writeFileSync(tmp, lines.join("\n"));
			renameSync(tmp, file);
			return;
		}
	} catch {
		// best effort: the file is already restored to the live tree
	}
}

function filesDiffer(a: string, b: string): boolean {
	try {
		return !readFileSync(a).equals(readFileSync(b));
	} catch {
		return true;
	}
}

export function sessionIdFromFile(file: string): string {
	const name = basename(file, ".jsonl");
	return name.slice(name.indexOf("_") + 1);
}

function parentSessionId(metaFile: string): string | undefined {
	try {
		return JSON.parse(readFileSync(metaFile, "utf8")).parentSessionId;
	} catch {
		return undefined;
	}
}

const SUBAGENT_ARTIFACT_SUFFIX = /^_(?:input\.md|output\.md|meta\.json|transcript\.jsonl)$/;

/**
 * Paths, relative to a per-cwd sessions dir, that belong to a session beside its
 * file: its `<file>/` dir (subagent runs, forks), its subagent-artifacts runs, and its agent-browser screenshots.
 */
export function findCompanions(dir: string, file: string): string[] {
	const id = sessionIdFromFile(file);
	const found = [basename(file, ".jsonl"), join(".pi-agent-browser-artifacts", id)].filter((rel) =>
		existsSync(join(dir, rel)),
	);
	const artifactsDir = join(dir, "subagent-artifacts");
	if (!existsSync(artifactsDir)) return found;
	const names = readdirSync(artifactsDir);
	for (const meta of names.filter((name) => name.endsWith("_meta.json"))) {
		if (parentSessionId(join(artifactsDir, meta)) !== id) continue;
		const run = meta.slice(0, -"_meta.json".length);
		for (const name of names) {
			if (name.startsWith(run) && SUBAGENT_ARTIFACT_SUFFIX.test(name.slice(run.length))) {
				found.push(join("subagent-artifacts", name));
			}
		}
	}
	return found;
}

/** Best effort: a companion whose destination already exists stays where it is. */
export function moveCompanions(fromDir: string, toDir: string, file: string): void {
	for (const rel of findCompanions(fromDir, file)) {
		const target = join(toDir, rel);
		if (existsSync(target)) continue;
		try {
			mkdirSync(dirname(target), { recursive: true });
			renameSync(join(fromDir, rel), target);
		} catch {}
	}
}

function parseEntries(file: string): { id?: string; parentId?: string | null; type?: string }[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return {};
			}
		});
}

/**
 * A headerless file at the live path is the tail pi kept writing after an
 * earlier move: append it to the archived copy when all its entries chain onto it.
 */
export function appendIfContinuation(fragment: string, archived: string): boolean {
	const tail = parseEntries(fragment);
	if (tail.length === 0 || tail[0].type === "session") return false;
	const archivedIds = new Set(parseEntries(archived).map((entry) => entry.id));
	const tailIds = new Set(tail.map((entry) => entry.id));
	const parents = tail.map((entry) => entry.parentId).filter((id): id is string => typeof id === "string");
	if (!parents.some((id) => archivedIds.has(id))) return false;
	if (!parents.every((id) => archivedIds.has(id) || tailIds.has(id))) return false;
	const separator = readFileSync(archived, "utf8").endsWith("\n") ? "" : "\n";
	appendFileSync(archived, separator + readFileSync(fragment, "utf8"));
	unlinkSync(fragment);
	return true;
}

function indexKeyOf(index: Record<string, IndexEntry>, archivedFile: string): string | undefined {
	return Object.keys(index).find((key) => join(archiveRoot(), key) === archivedFile);
}

/**
 * With `keepTag`, the session keeps its [ARCHIVE] tag and goes back to the archive when it closes.
 */
export function restoreArchived(archivedFile: string, targetDir: string, keepTag: boolean): string {
	mkdirSync(targetDir, { recursive: true });
	const target = join(targetDir, basename(archivedFile));
	renameSync(archivedFile, target);
	moveCompanions(dirname(archivedFile), targetDir, archivedFile);
	const index = readIndex();
	const rel = indexKeyOf(index, archivedFile);
	if (rel) {
		delete index[rel];
		writeIndex(index);
	}
	if (!keepTag) stripTagInFile(target);
	return target;
}

/**
 * Scrollable, filterable archive picker. Scopes to the current cwd by default
 * (tab toggles to all), sorts by archive date (ctrl+s toggles to name), and
 * filters on name or first message as you type.
 */
class ArchivePicker implements Component {
	private readonly all: SessionInfo[];
	private readonly archiveDates: Map<string, Date>;
	private readonly currentCwd: string;
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly kb: KeybindingsManager;
	private readonly search = new Input({ prompt: "filter: " });
	private readonly onSelect: (session: SessionInfo) => void;
	private readonly onCancel: () => void;
	private scope: Scope = "current";
	private sortMode: SortMode = "date";
	private filtered: SelectItem[] = [];
	private byPath = new Map<string, SessionInfo>();
	private list: SelectList;
	private selectedIndex = 0;

	constructor(options: {
		sessions: SessionInfo[];
		archiveDates: Map<string, Date>;
		currentCwd: string;
		theme: Theme;
		tui: TUI;
		keybindings: KeybindingsManager;
		onSelect: (session: SessionInfo) => void;
		onCancel: () => void;
	}) {
		this.all = options.sessions;
		this.archiveDates = options.archiveDates;
		this.currentCwd = options.currentCwd;
		this.theme = options.theme;
		this.tui = options.tui;
		this.kb = options.keybindings;
		this.onSelect = options.onSelect;
		this.onCancel = options.onCancel;
		this.list = this.buildList();
	}

	private archiveDate(info: SessionInfo): Date {
		const fromIndex = this.archiveDates.get(info.path);
		if (fromIndex) return fromIndex;
		try {
			return statSync(info.path).mtime;
		} catch {
			return new Date(0);
		}
	}

	private visible(): SessionInfo[] {
		const query = this.search.getValue().trim().toLowerCase();
		let items = this.all.filter(
			(s) => this.scope === "all" || (s.cwd && normalizeCwd(s.cwd) === normalizeCwd(this.currentCwd)),
		);
		if (query) {
			items = items.filter(
				(s) =>
					cleanName(s.name).toLowerCase().includes(query) || (s.firstMessage ?? "").toLowerCase().includes(query),
			);
		}
		if (this.sortMode === "date") {
			items = [...items].sort((a, b) => this.archiveDate(b).getTime() - this.archiveDate(a).getTime());
		} else {
			items = [...items].sort((a, b) => {
				const nameA = cleanName(a.name);
				const nameB = cleanName(b.name);
				const unnamedA = nameA === "(unnamed)";
				const unnamedB = nameB === "(unnamed)";
				if (unnamedA !== unnamedB) return unnamedA ? 1 : -1;
				return nameA.localeCompare(nameB);
			});
		}
		return items;
	}

	private buildList(): SelectList {
		const items = this.visible();
		this.filtered = items.map((s) => ({
			value: s.path,
			label: cleanName(s.name),
			description: `${relativeTime(this.archiveDate(s))}  ·  ${s.cwd || "(unknown cwd)"}`,
		}));
		this.byPath = new Map(items.map((s) => [s.path, s]));
		this.selectedIndex = 0;
		const list = new SelectList(this.filtered, MAX_VISIBLE, getSelectListTheme());
		list.onSelect = (item) => {
			const session = this.byPath.get(item.value);
			if (session) this.onSelect(session);
		};
		list.onCancel = () => this.onCancel();
		return list;
	}

	private rebuild(): void {
		this.list = this.buildList();
		this.tui.requestRender();
	}

	/** Mouse wheel/clicks move SelectList's internal index; keep our mirror in sync. */
	private syncIndex(): void {
		const selected = this.list.getSelectedItem();
		this.selectedIndex = selected ? this.filtered.findIndex((i) => i.value === selected.value) : 0;
	}

	private moveSelection(delta: number): void {
		const target = Math.max(0, Math.min(this.filtered.length - 1, this.selectedIndex + delta));
		this.list.setSelectedIndex(target);
		this.selectedIndex = target;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.kb.matches(data, "app.session.toggleSort")) {
			this.sortMode = this.sortMode === "date" ? "name" : "date";
			this.rebuild();
			return;
		}
		if (this.kb.matches(data, "tui.input.tab")) {
			this.scope = this.scope === "current" ? "all" : "current";
			this.rebuild();
			return;
		}
		if (this.kb.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-MAX_VISIBLE);
			return;
		}
		if (this.kb.matches(data, "tui.select.pageDown")) {
			this.moveSelection(MAX_VISIBLE);
			return;
		}
		if (
			this.kb.matches(data, "tui.select.up") ||
			this.kb.matches(data, "tui.select.down") ||
			this.kb.matches(data, "tui.select.confirm") ||
			this.kb.matches(data, "tui.select.cancel")
		) {
			this.list.handleInput(data);
			this.syncIndex();
			this.tui.requestRender();
			return;
		}
		const before = this.search.getValue();
		this.search.handleInput(data);
		if (this.search.getValue() !== before) this.rebuild();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const result = this.list.handleMouse(event);
		this.syncIndex();
		if (result?.render) this.tui.requestRender();
		return result;
	}

	/** Called on theme changes; rebuild so the list picks up the new theme. */
	invalidate(): void {
		this.list = this.buildList();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const border = (s: string) => this.theme.fg("accent", s);
		lines.push(...new DynamicBorder(border).render(width));
		const count = this.filtered.length;
		const scopeLabel = this.scope === "current" ? "current dir" : "all";
		const sortLabel = this.sortMode === "date" ? "archive date" : "name";
		const header = `${this.theme.fg("accent", this.theme.bold("Archived sessions"))}  ${this.theme.fg(
			"dim",
			`(${count} · scope: ${scopeLabel} · sort: ${sortLabel})`,
		)}`;
		lines.push(...new Text(header, 1, 0).render(width));
		lines.push(...this.search.render(width));
		if (count === 0) {
			lines.push(...new Text(this.theme.fg("muted", "No archived sessions match."), 1, 0).render(width));
		} else {
			lines.push(...this.list.render(width));
		}
		lines.push(
			...new Text(
				this.theme.fg("dim", "type to filter · tab scope · ctrl+s sort · enter resume · esc cancel"),
				1,
				0,
			).render(width),
		);
		lines.push(...new DynamicBorder(border).render(width));
		return lines;
	}
}

/** Load every archived session, with its archive date from the index when known. */
async function loadArchivedSessions(): Promise<{ sessions: SessionInfo[]; archiveDates: Map<string, Date> } | null> {
	const root = archiveRoot();
	if (!existsSync(root)) return null;
	const archiveDates = new Map<string, Date>();
	const index = readIndex();
	for (const [rel, entry] of Object.entries(index)) {
		archiveDates.set(join(root, rel), new Date(entry.archivedAt));
	}
	const dirs = [
		root,
		...readdirSync(root, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => join(root, e.name)),
	];
	const loaded = await Promise.all(dirs.map((dir) => SessionManager.listAll(dir)));
	const sessions = loaded.flat();
	return sessions.length > 0 ? { sessions, archiveDates } : null;
}

/** Shared move path: explicit targets never overwrite an existing archive. */
function moveSessionToArchive(file: string, cwd: string, name: string | undefined, replaceStale = false): void {
	const dir = join(archiveRoot(), cwdDirName(cwd));
	mkdirSync(dir, { recursive: true });
	const target = join(dir, basename(file));
	if (existsSync(target)) {
		if (!replaceStale) throw new Error("An archived copy already exists; nothing was archived.");
		if (filesDiffer(file, target) && !appendIfContinuation(file, target)) {
			renameSync(target, `${target}.superseded-${Date.now()}`);
		}
	}
	if (existsSync(file)) renameSync(file, target);
	moveCompanions(dirname(file), dir, file);

	const index = readIndex();
	index[join(cwdDirName(cwd), basename(file))] = {
		name: (name ?? "").replace(ARCHIVE_TAG, "").trim() || "(unnamed)",
		cwd,
		archivedAt: new Date().toISOString(),
	};
	writeIndex(index);
}

// Match Pi's full-ID grammar, including custom IDs. Never treat input as a
// path, session name, UUID prefix, or search query.
const SESSION_ID_PATTERN = "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$";

export default function sessionArchive(pi: ExtensionAPI) {
	let archiveOnShutdown = false;
	let presence: SessionPresence | undefined;

	function archive(ctx: { ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } }): string {
		pi.setSessionName(tagged(pi.getSessionName()));
		archiveOnShutdown = true;
		const message = "Session archived: tagged [ARCHIVE] now, leaves /resume once the session closes.";
		ctx.ui.notify(message, "info");
		return message;
	}

	async function archiveById(sessionId: string | undefined, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		if (sessionId === undefined) return archive(ctx);
		if (!new RegExp(SESSION_ID_PATTERN).test(sessionId)) {
			throw new Error("Use one complete session ID, not a name, path, or ID prefix.");
		}
		const isCurrent = sessionId === ctx.sessionManager.getSessionId();

		// Include the current session directory for --session-dir users; deduplicate
		// paths also returned by the normal all-directory discovery.
		const sessions = [
			...await SessionManager.listAll(),
			...await SessionManager.listAll(ctx.sessionManager.getSessionDir()),
		];
		signal?.throwIfAborted();
		const matches = new Map<string, SessionInfo>();
		for (const session of sessions) {
			if (session.id === sessionId) matches.set(canonicalSessionFile(session.path), session);
		}
		if (isCurrent) {
			const currentFile = ctx.sessionManager.getSessionFile();
			const canonical = currentFile ? canonicalSessionFile(currentFile) : undefined;
			if ([...matches.keys()].some((file) => file !== canonical)) {
				throw new Error(`Multiple session files have ID ${sessionId}; nothing was archived.`);
			}
			// New sessions may not have been flushed to disk yet.
			return archive(ctx);
		}
		if (matches.size === 0) throw new Error(`No saved session with exact ID ${sessionId}.`);
		if (matches.size !== 1) throw new Error(`Multiple session files have ID ${sessionId}; nothing was archived.`);
		const [file, session] = [...matches][0];

		// Do not await between the final activity check and moving the file.
		assertSessionNotActive(archiveRoot(), file);
		const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]);
		if (header.type !== "session" || header.id !== sessionId || typeof header.cwd !== "string" || !header.cwd) {
			throw new Error("Session header changed or is invalid; nothing was archived.");
		}
		moveSessionToArchive(file, header.cwd, session.name);
		const message = `Archived session ${sessionId}. Browse it with /archives.`;
		ctx.ui.notify(message, "info");
		return message;
	}

	pi.registerTool({
		name: "archive_session",
		label: "Archive session",
		description:
		"Archive a session at the user's request. Omit sessionId to tag the current session for archiving on close. " +
		"Supply a complete sessionId to archive another saved session immediately; names, paths, and ID prefixes are not accepted. " +
		"Refuses sessions recorded as open by this extension, even if idle. Do not target a session open in a process without this extension.",
		parameters: Type.Object({
			sessionId: Type.Optional(Type.String({
				pattern: SESSION_ID_PATTERN,
				description: "Complete, exact session ID (not a name, path, or prefix). Omit for the current session.",
			})),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: await archiveById(params.sessionId, ctx, signal) }], details: {} };
		},
	});

	pi.registerCommand("archive", {
		description: "Archive the current session on close, or /archive <session-id> for another closed session",
		handler: async (args, ctx) => {
			try {
				await archiveById(args.trim() || undefined, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("archives", {
		description: "Browse archived sessions; restore one, resume it, or both",
		handler: async (_args, ctx) => {
			const loaded = await loadArchivedSessions();
			if (!loaded) {
				ctx.ui.notify("No archived sessions yet", "info");
				return;
			}
			const { sessions, archiveDates } = loaded;
			const index = readIndex();

			let chosen: SessionInfo | undefined;
			if (ctx.mode === "tui") {
				chosen = await ctx.ui.custom<SessionInfo | null>((tui, theme, keybindings, done) => {
					return new ArchivePicker({
						sessions,
						archiveDates,
						currentCwd: ctx.cwd,
						theme,
						tui,
						keybindings,
						onSelect: (session) => done(session),
						onCancel: () => done(null),
					});
				}) ?? undefined;
			} else {
				// Non-TUI (rpc/json/print): no custom components, fall back to a flat list.
				const options = sessions.map((s) => `${cleanName(s.name)}  ·  ${s.cwd || "?"}  ·  ${relativeTime(archiveDates.get(s.path) ?? s.modified)}`);
				const choice = await ctx.ui.select("Resume an archived session (Enter to resume, Esc to cancel)", options);
				if (choice === undefined) return;
				chosen = sessions[options.indexOf(choice)];
			}
			if (!chosen) return;

			const archivedFile = chosen.path;
			if (!existsSync(archivedFile)) {
				ctx.ui.notify("Archived file no longer on disk", "warning");
				return;
			}
			const rel = indexKeyOf(index, archivedFile);
			const cwd = chosen.cwd || headerCwd(archivedFile) || (rel ? index[rel]?.cwd : undefined);
			if (!cwd) {
				ctx.ui.notify("Session header unreadable; resume it with: pi --session <file>", "warning");
				return;
			}

			const targetDir = join(getAgentDir(), "sessions", cwdDirName(cwd));
			const target = join(targetDir, basename(archivedFile));
			if (existsSync(target)) {
				// The session file already exists in the live tree (e.g. the session
				// kept running after an archive attempt). Resume that copy and leave
				// the archived one plus its index entry; the next shutdown of the
				// live copy supersedes the stale archive.
				const action = await ctx.ui.select("A live copy of this session exists; the archived copy stays in place", [
					RESUME_LIVE_COPY,
					CANCEL,
				]);
				if (action === RESUME_LIVE_COPY) await ctx.switchSession(target);
				return;
			}

			const action = await ctx.ui.select(`${cleanName(chosen.name)}: what now?`, [
				RESTORE_AND_RESUME,
				RESUME_KEEP_ARCHIVED,
				RESTORE_ONLY,
				CANCEL,
			]);
			if (action === undefined || action === CANCEL) return;

			restoreArchived(archivedFile, targetDir, action === RESUME_KEEP_ARCHIVED);
			if (action === RESTORE_ONLY) {
				ctx.ui.notify("Restored to /resume", "info");
				return;
			}
			if (action === RESUME_KEEP_ARCHIVED) ctx.ui.notify("Resuming; back to the archive when it closes", "info");
			await ctx.switchSession(target);
		},
	});

	// A tagged session that never got moved (crash before shutdown) re-arms the
	// move; a session resumed straight from the archive dir sheds the tag.
	pi.on("session_start", (_event, ctx) => {
		const file = ctx.sessionManager.getSessionFile() ?? "";
		if (file) presence = trackSession(ctx.sessionManager, archiveRoot(), file);
		if (file.startsWith(archiveRoot())) {
			const name = pi.getSessionName();
			if (name?.startsWith(ARCHIVE_TAG)) pi.setSessionName(name.slice(ARCHIVE_TAG.length));
			archiveOnShutdown = false;
			return;
		}
		archiveOnShutdown = Boolean(pi.getSessionName()?.startsWith(ARCHIVE_TAG));
	});

	pi.on("session_shutdown", (event, ctx) => {
		// Keep both the file and its presence record across /reload.
		if (event.reason === "reload") return;
		const file = ctx.sessionManager.getSessionFile();
		try {
			if (!archiveOnShutdown || !file || event.targetSessionFile === file || !existsSync(file)) return;
			// The same transcript may be open in another process or SDK session.
			assertSessionNotActive(archiveRoot(), file, presence?.marker);
			moveSessionToArchive(file, headerCwd(file) ?? ctx.sessionManager.getCwd(), pi.getSessionName(), true);
		} finally {
			untrackSession(ctx.sessionManager);
			presence = undefined;
		}
	});
}
