# @clementprevot/pi-session-archive

A [Pi](https://pi.dev) extension that archives finished sessions out of the `/resume` list without deleting them. Ask the agent to archive when you wrap up, run `/archive` yourself, and browse the archive with `/archives` to restore and resume anything later.

## Install

```bash
pi install npm:@clementprevot/pi-session-archive
```

Updates ship with `pi update --extensions`. The extension applies to your next session (quit and relaunch or issue a `/reload` command).

## How it works

Archiving is deliberately two-phase, so nothing is pulled from under the live session manager:

1. On archive (agent tool, `/archive`, or the picker), the session is only renamed with an `[ARCHIVE]` tag. It still runs normally.
2. When the session closes (`session_shutdown`), the file physically moves out of pi's sessions tree into `~/.pi/agent/sessions-archive/`, in a per-cwd subdirectory. An `index.json` there records the original name, cwd, and archive date. A `/reload` is not a close: the session keeps running on the same file, so nothing moves.

`/archives` opens a scrollable picker over that tree: type to filter on name or first message, tab toggles scope (current directory vs all, like `/resume`), ctrl+s toggles sort (archive date vs name). Selecting an entry moves the file back into the per-cwd sessions directory, strips the `[ARCHIVE]` tag (temp file plus rename, so a crash cannot truncate the file), and offers to resume it right away.

A tagged session that never got moved (crash before shutdown) re-arms the move on its next start, and a session resumed straight from the archive dir sheds the tag. If pi wrote a few more entries after an earlier move, the headerless tail it left behind is appended to the archived copy instead of replacing it.

## Configuration

None.

## Privacy and data

Everything stays on disk under the pi agent directory (`~/.pi/agent/`). Nothing is uploaded anywhere, and the extension makes no network calls.

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
