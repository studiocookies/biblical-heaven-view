# OBSIDIAN — Architecture Decision Record

Status: accepted · Date: 2026-10-10

## 1. Discovery findings

Discovery ran in the build environment (a Linux x86_64 cloud container), **not on
the target MacBook Air**. Everything below about the CLI was verified against
Claude Code **2.1.296** installed there. Anything machine-specific (macOS version,
Claude install location, login state) is detected **at runtime** by OBSIDIAN on
the Mac rather than assumed.

| Question | Verified answer |
| --- | --- |
| How is Claude Code launched? | `claude` executable; interactive by default when attached to a TTY. |
| Is the user logged in? | `claude auth status --json` prints `{loggedIn, authMethod, apiProvider, …}` — no tokens. OBSIDIAN reads only whitelisted fields. |
| New session with a known id | `--session-id <uuid>` |
| Resume | `-r/--resume <id>` (no id → Claude's own interactive picker), `-c/--continue` (most recent in cwd) |
| Model choice | `--model <alias or name>` |
| Permission handling | Interactive prompts happen inside the TUI. `--permission-mode` exists; OBSIDIAN never passes `bypassPermissions` or `--dangerously-skip-permissions`. |
| Live status | `claude agents --json` lists active sessions `{sessionId, pid, cwd, kind, status, name, startedAt}`; `status` was observed as `busy`. |
| Model actually used | Session transcripts at `<projectsDirectory>/<cwd with non-alphanumerics → "-">/<sessionId>.jsonl`; `assistant` entries carry `message.model` and `tool_use` blocks. This format is **internal / undocumented**, so it is treated as best-effort and read-only. |
| Structured output (`--print --output-format stream-json`) | Exists, but it is non-interactive and loses the native TUI, permission prompts and slash commands. Not used for the primary workflow. |
| node-pty | 1.1.0 ships N-API prebuilds for `darwin-arm64` → no Xcode / no Electron rebuild needed on Apple Silicon. |

Flags differ between Claude Code versions, so OBSIDIAN **feature-detects** by
parsing `claude --help` and `claude agents --help` once per detected version and
disables actions the installed CLI does not support.

## 2. Decision

**Electron + TypeScript + React**, with **xterm.js** connected to a **node-pty**
pseudo-terminal that runs the user's own `claude` executable.

```
┌──────────────── Renderer (sandboxed, no Node) ───────────────┐
│ React UI · xterm.js · zustand store                          │
│            window.obsidian  (contextBridge, typed)           │
└──────────────────────────┬───────────────────────────────────┘
                           │ narrow IPC (invoke + 3 event channels)
┌──────────────────────────┴───────────────────────────────────┐
│ Main process                                                  │
│  ipc.ts ── validates every payload                            │
│  claude/detect     executable + version + auth + capabilities │
│  claude/sessions   node-pty lifecycle, flow control, cleanup  │
│  claude/transcript tail <session>.jsonl → model, activity     │
│  claude/agents     poll `claude agents --json` → live status  │
│  git/*             execFile("git", fixed argv)                │
│  fs/*              lazy tree, contained reads, fs.watch       │
│  store             JSON in ~/Library/Application Support      │
└──────────────────────────┬───────────────────────────────────┘
                           │ PTY
                     claude (user's install, user's auth)
```

### Why a real PTY instead of an API wrapper
* Subscription auth keeps working exactly as in Terminal — OBSIDIAN never
  touches tokens, keychain items, or `~/.claude` credentials.
* Permission prompts, slash commands, `/model`, `/resume`, plan mode, etc. are
  the CLI's own; nothing is reimplemented or faked.
* The API path would require an API key and different billing — explicitly out
  of scope.

### Why not electron-vite
electron-vite 5 does not support Vite 8. The build is therefore Vite for the
renderer and a ~60-line esbuild script for main/preload. Fewer moving parts.

## 3. Security model

* `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP,
  navigation and `window.open` blocked, all permission requests denied.
* The renderer **cannot name an executable or an arbitrary path**:
  * Projects are added only through the native folder dialog (main process).
    The renderer refers to projects by id.
  * A custom Claude executable is chosen only through the native file dialog.
  * File reads are relative paths, resolved with `realpath` and rejected if they
    escape the project root; size-capped and binary-detected.
* Sessions are spawned from a structured request (`kind`, `projectId`, `mode`,
  optional `model`, `permissionMode` from an allow-list that excludes bypass).
  Main builds argv; no shell string is ever evaluated.
* Shell tabs launch the user's login shell only if it is listed in `/etc/shells`.
* Git runs via `execFile("git", [...])` with fixed sub-commands; paths are passed
  after `--`. Destructive operations (discard changes) require a **native**
  confirmation dialog shown by main, so a compromised renderer cannot skip it.
* Only `http(s)` links are opened externally.
* Termination only signals PIDs OBSIDIAN spawned (SIGHUP → SIGKILL after 3 s).
* Logs never contain environment variables or terminal content.

## 4. Performance (fanless MacBook Air)

* PTY output is coalesced (≈8 ms batches) and flow-controlled with high/low
  watermarks: main pauses the PTY when the renderer falls >1 MB behind.
* xterm uses the WebGL renderer, falling back to DOM on context loss.
* File tree loads one directory at a time; `fs.watch` (FSEvents on macOS) is
  debounced and only re-lists expanded directories.
* `claude agents --json` is polled every 5 s **only while a Claude session is
  alive and the window is visible**.
* Transcript tailing reads appended bytes only.

## 5. Tradeoffs & risks

| Risk | Mitigation |
| --- | --- |
| Finder-launched apps get a minimal `PATH` → `claude`/`node` not found | Resolve the login shell `PATH` once at startup (`$SHELL -ilc`), probe well-known install locations, allow a manual path. |
| Transcript format may change | Parsed defensively; every derived value is labeled "from transcript"; absence never breaks the session. |
| `claude agents` may be missing in older versions | Capability-detected; status falls back to "process running". |
| Resuming a session that never received a prompt fails in the CLI | Resume is only offered when a transcript exists; otherwise Claude's error is shown verbatim in the terminal. |
| Electron footprint (~200 MB on disk, ~150 MB RAM) | Accepted for terminal fidelity and UI richness; no other background services. |

## 6. Addenda: decisions forced by testing

These came out of running the real app end to end. Each one is covered by a test.

| Finding | Decision |
| --- | --- |
| A session started from inside another Claude Code session inherited `CLAUDE_CODE_CHILD_SESSION`, so Claude Code turned transcript saving off (no model, history or resume). | Strip parent-session identity markers from child environments, and never strip user configuration (`src/main/env.ts`, unit-tested). |
| node-pty's macOS prebuild ships `spawn-helper` without the executable bit, so every spawn fails with `posix_spawnp failed`. | `postinstall` restores `+x`, and the session manager repairs it at runtime or reports the exact `chmod` to run. node-pty is `asarUnpack`ed. |
| Chromium's `scrollIntoView()` now returns a Promise. An expression-bodied `useEffect` handed it to React as a cleanup, which crashed the whole renderer. | All effects use block bodies. Each region (navigator, workspace, intelligence, bottom panel, palette) has its own error boundary. Sessions live in the main process, so "Reload interface" is always safe. |
| Claude Code generates conversation titles from your prompt. Persisting them would copy prompt content to disk. | Titles are read live from Claude's transcripts and never stored. |
| A keystroke can reach both the renderer handler and a native menu accelerator. | Commands are deduplicated by source (keyboard vs. menu). Repeated keypresses are never swallowed. |
| An explicitly configured `claude` path that goes missing could silently fall back to some other binary. | An explicit choice is never replaced. Detection reports it as missing. |
| On small windows, fixed panel widths starved the terminal. | Side panels shrink in proportion, down to their minimum widths, so the terminal keeps at least ~460 px. |
