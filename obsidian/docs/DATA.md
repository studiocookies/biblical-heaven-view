# What OBSIDIAN stores, reads, and never touches

## Stored by OBSIDIAN

All files are JSON, written atomically with mode `600`, in
`~/Library/Application Support/OBSIDIAN/` (Settings → Data & Privacy → **Show in Finder**).

| File | Contents | Never contains |
| --- | --- | --- |
| `settings.json` | Preferences: layout, panel sizes, terminal font, contrast/motion, shortcuts, default model and permission mode, an optional custom `claude` path chosen in a native dialog | credentials, environment variables |
| `projects.json` | For each folder you opened: id, name, absolute path, added/opened timestamps | file contents |
| `sessions.json` | For Claude sessions started in OBSIDIAN: Claude session id, project id, a generic title, created/last-active timestamps, the model you requested | prompts, replies, terminal output, AI-generated titles |
| `tasks.json` | Your manual tasks: title, done flag, project, timestamps | — |

Removing a project only removes it from `projects.json`. No files are touched.

## Read, never stored

- **Claude Code transcripts** (`<projectsDirectory>/<project>/<session>.jsonl`, normally `~/.claude/projects`) are read **in memory** to show the model, turn state, activity timeline, Claude's todo list and conversation titles. Only appended bytes are read while a session runs. Nothing from them is copied to disk.
- **`claude auth status --json`**: only `loggedIn`, `authMethod`, `apiProvider` and `projectsDirectory` are kept. Any other field (such as an email address) is discarded as soon as the output is parsed.
- **`claude agents --json`**: session id, pid, cwd, kind, status, name and start time, held in memory.
- **`.claude/agents/*.md`**: name, description and model fields from the frontmatter.
- **Your login shell's `PATH`**: read once at startup, so `claude` and `node` resolve the same way they do in Terminal. No other variable is read from the shell.
- **Project files and git**: listed and read only on demand, within the project folder.

## Never touched

- Claude Code credentials, keychain items, `~/.claude.json`, or settings files. OBSIDIAN doesn't change your Claude Code configuration.
- Terminal output is never written to disk, logged, or sent anywhere. The diagnostics panel records command lines, pids and exit codes in memory only.
- OBSIDIAN makes no network requests of its own. Links you click in the terminal open in your browser.

## Environment passed to sessions

Sessions inherit your environment (Claude Code needs it for auth and configuration) with three changes:

1. `PATH` is extended with your login shell's `PATH` and the standard install locations.
2. `TERM=xterm-256color`, `COLORTERM=truecolor` and `TERM_PROGRAM=OBSIDIAN` are set, and `LANG` defaults to `en_US.UTF-8` if it's missing.
3. Variables that identify a **parent** Claude Code session are removed (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, `CLAUDE_CODE_SSE_PORT`), along with Electron internals. Your configuration variables, such as `CLAUDE_CONFIG_DIR`, provider settings and `ANTHROPIC_API_KEY`, are passed through unchanged. Mission Control warns you if `ANTHROPIC_API_KEY` is set.
