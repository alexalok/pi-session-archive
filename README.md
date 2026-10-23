# @clementprevot/pi-session-archive

A [Pi](https://pi.dev) extension that archives finished sessions out of the `/resume` list without deleting them. Ask the agent to archive when you wrap up, run `/archive` yourself, and browse the archive with `/archives` to restore and resume anything later.

## Install

```bash
pi install npm:@clementprevot/pi-session-archive
```

Updates ship with `pi update --extensions`. The extension applies to your next session (quit and relaunch or issue a `/reload` command).

## Archive by session ID

- `/archive` or `archive_session({})`: archive the **current** session on close, as before.
- `/archive <session-id>` or `archive_session({ "sessionId": "<session-id>" })`: archive another saved session immediately, without switching chats. Its transcript and companions move together and remain available in `/archives`.
- Passing the current session's ID keeps the deferred, archive-on-close behavior.

Targets must be **complete, exact session IDs**, including custom IDs supported by Pi. Names, paths, ID prefixes, search queries, and multiple IDs in one call are not accepted. Get the current ID with `/session`, or read the `id` in a saved session's JSONL header. Lookup covers Pi's normal sessions tree and the current session directory (for `--session-dir`). Missing or duplicate IDs are refused, never interpreted as the current session. An existing archived copy is not overwritten.

### Protecting open sessions

This version records each open session under `sessions-archive/.active/` and checks whether its owning PID is still alive. Another recorded session cannot be archived while open, **even if idle**: inference-only protection would miss tabs that can write again. No interaction timestamp, heartbeat timeout, or inferred inactivity is used. Records survive `/reload`; normal session shutdown removes them. Records from definitely exited processes do not block archiving. Unreadable records, an unverifiable PID, or records from another host block the operation instead of guessing. A reused PID can conservatively block an archive.

**This is a cooperative guard, not an OS-level lock or universal activity detector.** All Pi processes sharing these sessions must load this version. Older processes, processes with the extension disabled, and the interval before a process reaches `session_start` cannot be reliably detected. Do not concurrently resume a session being archived, and close untracked tabs yourself. Disabling the extension during `/reload` can leave a protective record until that process exits. Shared storage across hosts/PID namespaces is not supported for activity detection.

## How current-session archiving works

Archiving the current session is deliberately two-phase, so nothing is pulled from under the live session manager:

1. On archive (agent tool, `/archive`, or the picker), the session is only renamed with an `[ARCHIVE]` tag. It still runs normally.
2. When the session closes (`session_shutdown`), the file physically moves out of pi's sessions tree into `~/.pi/agent/sessions-archive/`, in a per-cwd subdirectory. Its companions move with it: the `<session>/` directory (subagent runs, forks), the `subagent-artifacts` runs whose meta names it as parent, and its agent-browser screenshots. An `index.json` there records the original name, cwd, and archive date. A `/reload` is not a close: the session keeps running on the same file, so nothing moves.

`/archives` opens a scrollable picker over that tree: type to filter on name or first message, tab toggles scope (current directory vs all, like `/resume`), ctrl+s toggles sort (archive date vs name). Selecting an entry asks what to do before anything moves:

- Restore and resume: moves the file and its companions back into the per-cwd sessions directory, strips the `[ARCHIVE]` tag (temp file plus rename, so a crash cannot truncate the file), and switches to it.
- Resume, keep archived: moves it back the same way but keeps the tag, so the session returns to the archive when it closes.
- Restore only: moves it back and strips the tag, but you stay in the current session.
- Cancel (or Esc): leaves everything in the archive.

If a live copy of the session already exists, the picker only offers to resume that copy or cancel.

A tagged session that never got moved (crash before shutdown) re-arms the move on its next start, and a session resumed straight from the archive dir sheds the tag. If pi wrote a few more entries after an earlier move, the headerless tail it left behind is appended to the archived copy instead of replacing it.

## Configuration

None.

## Privacy and data

Everything stays on disk under the pi agent directory (`~/.pi/agent/`). Nothing is uploaded anywhere, and the extension makes no network calls. Activity records contain only the local process ID and hostname; session paths are hashed for their directory names.

This pairs well with [@clementprevot/pi-session-search](https://github.com/clementprevot/pi-session-search), which can find sessions past `/resume`'s window and restore archived ones.

## Local development

```bash
npm install
npm test
npm run typecheck
```

To try the extension in a live session without installing it:

```bash
pi -e /path/to/this/repo
```

## License

[MIT](LICENSE)
