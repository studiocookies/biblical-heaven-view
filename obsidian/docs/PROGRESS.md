# Progress log

## Milestones

1. **Discovery.** Inspected the build environment (Linux x86_64, Node 22, Claude Code 2.1.296 signed in with OAuth). Verified the CLI surface against `--help`: `--session-id`, `--resume`, `--continue`, `--model`, `--permission-mode`, `--name`, `claude auth status --json` and `claude agents --json`. Confirmed that node-pty 1.1.0 ships N-API prebuilds for `darwin-arm64`. Wrote the [ADR](ARCHITECTURE.md).
2. **Toolchain.** npm 10's resolver crashes on Vite 8 / vitest 4.1's peer sets (`Cannot read properties of null (reading 'edgesOut')`). Pinned the mature Vite 7.3 / vitest 4.0 / plugin-react 5.1 line instead of switching package managers, so `npm install` works as-is on your Mac. electron-vite doesn't support Vite 8, so main and preload are bundled by a small esbuild script.
3. **Main process.** Hardened window, validated IPC, PTY session manager with output batching and flow control, CLI detection with login-shell `PATH` resolution and capability probing, transcript tailing, adaptive live-status polling, git and filesystem services, atomic JSON store.
4. **Renderer.** Design tokens and materials (brushed aluminum, dark wells, ice-blue instrumentation), chassis, rail, tabbed workspace with xterm.js, session header with provenance labels, sidebar views, intelligence panel, bottom panel, Mission Control, settings, command palette, quick open, toasts.
5. **End-to-end testing against the real app.** Testing found and fixed: parent-session env markers disabling transcripts, a renderer crash from Promise-returning `scrollIntoView`, prompt-derived titles being persisted, menu/keyboard command dedupe swallowing real keypresses, and fixed panel widths starving the terminal on small windows.
6. **Packaging.** electron-builder config (DMG + zip, arm64, hardened runtime entitlements, node-pty unpacked). Packaged and tested on Linux. Found that macOS `spawn-helper` ships non-executable, and fixed it with a postinstall script plus a runtime self-check.

## Test results

Run on 2026-10-10 in the Linux x86_64 build container (Xvfb display, Electron 44.4.5, Claude Code 2.1.296).

| Suite | Result |
| --- | --- |
| `npm run typecheck` (renderer + main) | clean |
| `npm test`: unit (validation, argv building, detection parsing, env stripping, git against a real repo, transcript parsing and tailing, contained fs access, store) | **36 / 36** |
| e2e: core workspace (security, files, git, diff, stage, commit, shell PTY I/O, OSC title, resize→`stty size`, panels, palette, motion/contrast, reload survival, exit codes, stored data) | **26 / 26** |
| e2e: failure modes (missing executable, logged-out CLI stub, structured argv) | **5 / 5** |
| e2e: gallery (palette, quick open, tasks persist, no overflow at 980×620) | **5 / 5** |
| e2e: quit lifecycle (confirm → cancel keeps sessions; confirm → child process ends) | **3 / 3** |
| e2e: **real Claude Code session** (launch with session id → trust prompt → prompt round trip → model from transcript → live status → close kills exactly that pid → `--resume <id>` → no prompt text stored) | **9 / 9** |
| e2e core suite against the **packaged** build (`release/linux-unpacked`) | **26 / 26** |
| Dev mode (`OBSIDIAN_DEV_URL` + Vite dev server, IPC origin check) | pass |

### Not verified (no Mac available in the build environment)

- Running on macOS and Apple Silicon: traffic-light placement, hidden-inset title bar, SF Pro / SF Mono rendering, the `darwin-arm64` node-pty prebuild loading inside Electron, FSEvents recursive watch, Finder-launched `PATH` resolution through zsh.
- `npm run package:mac` (electron-builder can only build DMGs on macOS).
- Native Edit-menu copy/paste on macOS (it uses Electron's standard roles, which xterm.js handles through copy and paste events).
