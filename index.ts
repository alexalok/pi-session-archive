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
import { basename, join, resolve } from "node:path";

const ARCHIVE_TAG = "[ARCHIVE] ";
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
 * in place (temp file + rename so a crash cannot truncate it). Restore-only
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

export default function sessionArchive(pi: ExtensionAPI) {
	let archiveOnShutdown = false;

	function archive(ctx: { ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } }): string {
		pi.setSessionName(tagged(pi.getSessionName()));
		archiveOnShutdown = true;
		const message = "Session archived: tagged [ARCHIVE] now, leaves /resume once the session closes.";
		ctx.ui.notify(message, "info");
		return message;
	}

	pi.registerTool({
		name: "archive_session",
		label: "Archive session",
		description:
		"Archive the current session when the user says the work on it is done (\"we're done\", \"archive this session\"). Tags it [ARCHIVE] and moves it out of /resume once the session closes. Takes no arguments.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: archive(ctx) }], details: {} };
		},
	});

	pi.registerCommand("archive", {
		description: "Archive the current session (tag + move out of /resume on close)",
		handler: async (_args, ctx) => {
			archive(ctx);
		},
	});

	pi.registerCommand("archives", {
		description: "Browse archived sessions; selecting one moves it back and resumes it",
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
			const rel = Object.keys(index).find((key) => join(archiveRoot(), key) === archivedFile);
			const cwd = chosen.cwd || headerCwd(archivedFile) || (rel ? index[rel]?.cwd : undefined);
			if (!cwd) {
				ctx.ui.notify("Session header unreadable; resume it with: pi --session <file>", "warning");
				return;
			}

			// Move back into the live sessions tree, in the cwd dir it was born in.
			const targetDir = join(getAgentDir(), "sessions", cwdDirName(cwd));
			mkdirSync(targetDir, { recursive: true });
			const target = join(targetDir, basename(archivedFile));
			const liveCopyExists = existsSync(target);
			if (liveCopyExists) {
				// The session file already exists in the live tree (e.g. the session
				// kept running after an archive attempt). Resume that copy and leave
				// the archived one plus its index entry; the next shutdown of the
				// live copy supersedes the stale archive.
				ctx.ui.notify("Live copy of this session already exists; archived copy left in place", "info");
			} else {
				renameSync(archivedFile, target);

				const nextIndex = readIndex();
				if (rel) delete nextIndex[rel];
				writeIndex(nextIndex);

				ctx.ui.notify("Restored to /resume", "info");
			}
			const action = await ctx.ui.select(liveCopyExists ? "Live copy found; resume it?" : "Session restored to /resume", [
				"Resume it now",
				"Stay in the current session",
			]);
			if (action === "Resume it now") {
				ctx.ui.notify("Resuming; the [ARCHIVE] tag drops on load", "info");
				await ctx.switchSession(target);
				return;
			}
			stripTagInFile(target);
			ctx.ui.notify("Left in /resume without the tag", "info");
		},
	});

	// A tagged session that never got moved (crash before shutdown) re-arms the
	// move; a session resumed straight from the archive dir sheds the tag.
	pi.on("session_start", (_event, ctx) => {
		const file = ctx.sessionManager.getSessionFile() ?? "";
		if (file.startsWith(archiveRoot())) {
			const name = pi.getSessionName();
			if (name?.startsWith(ARCHIVE_TAG)) pi.setSessionName(name.slice(ARCHIVE_TAG.length));
			archiveOnShutdown = false;
			return;
		}
		archiveOnShutdown = Boolean(pi.getSessionName()?.startsWith(ARCHIVE_TAG));
	});

	pi.on("session_shutdown", (event, ctx) => {
		if (!archiveOnShutdown) return;
		// A reload keeps this session running on the same file; moving it now
		// makes pi recreate a headerless tail at the old path.
		if (event.reason === "reload") return;
		const file = ctx.sessionManager.getSessionFile();
		if (!file || event.targetSessionFile === file) return;
		const cwd = headerCwd(file) ?? ctx.sessionManager.getCwd();
		const dir = join(archiveRoot(), cwdDirName(cwd));
		mkdirSync(dir, { recursive: true });
		const target = join(dir, basename(file));
		if (existsSync(target) && filesDiffer(file, target) && !appendIfContinuation(file, target)) {
			// A stale copy (e.g. left by a restore that found the file already live)
			// must not silently block the move forever.
			renameSync(target, `${target}.superseded-${Date.now()}`);
		}
		if (existsSync(file)) renameSync(file, target);

		const rel = join(cwdDirName(cwd), basename(file));
		const index = readIndex();
		index[rel] = {
			name: (pi.getSessionName() ?? "").replace(ARCHIVE_TAG, "").trim() || "(unnamed)",
			cwd,
			archivedAt: new Date().toISOString(),
		};
		writeIndex(index);
	});
}
