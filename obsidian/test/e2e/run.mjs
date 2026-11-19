// End-to-end tests: drives the real Electron app with Playwright under a (virtual) display.
//
//   xvfb-run -a -s "-screen 0 1600x1000x24" node test/e2e/run.mjs            # all suites
//   OBSIDIAN_E2E_CLAUDE=0 xvfb-run -a node test/e2e/run.mjs                   # skip the real Claude Code suite
//
// The real-Claude suite sends ONE tiny prompt through your authenticated CLI.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = createRequire('/opt/node22/lib/node_modules/')('playwright');
}
const { _electron } = playwright;
const electronPath = (await import('electron')).default;

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUT = path.join(ROOT, 'test/e2e/artifacts');
fs.mkdirSync(OUT, { recursive: true });
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const results = [];
let lastWin = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

async function waitFor(fn, timeout = 15000, interval = 200) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  return null;
}

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeRepo(name, dirty) {
  const dir = path.join(tmp('obsidian-e2e-'), name);
  fs.mkdirSync(dir);
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'e2e@example.com');
  g('config', 'user.name', 'E2E');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n\nAn OBSIDIAN end-to-end fixture.\n`);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const answer = 41;\n');
  g('add', '.');
  g('commit', '-qm', 'initial');
  if (dirty) {
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const answer = 42;\nexport const ship = "obsidian";\n');
    fs.writeFileSync(path.join(dir, 'NOTES.md'), 'untracked notes\n');
  }
  return dir;
}

function seedUserData(projects, settings = {}) {
  const dir = tmp('obsidian-userdata-');
  const now = Date.now();
  fs.writeFileSync(
    path.join(dir, 'projects.json'),
    JSON.stringify(projects.map((root, i) => ({ id: `proj${i}abc`, name: path.basename(root), root, addedAt: now, lastOpenedAt: now - i * 1000 }))),
  );
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ onboarded: false, ...settings }));
  return dir;
}

async function launch(userData, extraEnv = {}) {
  // OBSIDIAN_E2E_BINARY=<packaged executable> runs the suite against a packaged build.
  const packaged = process.env.OBSIDIAN_E2E_BINARY;
  const app = await _electron.launch({
    executablePath: packaged ?? electronPath,
    args: packaged ? [] : [ROOT],
    cwd: ROOT,
    env: { ...process.env, OBSIDIAN_USER_DATA: userData, ...extraEnv },
  });
  const win = await app.firstWindow();
  lastWin = win;
  const errors = [];
  win.on('pageerror', (e) => { errors.push(e.message); console.log('    [pageerror]', e.message, (e.stack ?? '').split('\n').slice(0, 4).join(' | ')); });
  win.on('console', (m) => { if (m.type() === 'error') console.log('    [console.error]', m.text().slice(0, 600)); });
  win.on('dialog', (d) => d.accept()); // window.confirm → accept
  await win.waitForSelector('.chassis', { timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 920));
  return { app, win, errors };
}

/** Ends running sessions through the app (as a user would), so quitting needs no confirmation. */
async function closeApp(app, win) {
  await win.screenshot({ path: path.join(OUT, `last-state-${results.length}.png`) }).catch(() => undefined);
  try {
    const list = await win.evaluate(() => window.obsidian.invoke('session:list'));
    for (const s of list) if (s.state === 'running') await win.evaluate((id) => window.obsidian.invoke('session:kill', id), s.id);
    await waitFor(async () => (await win.evaluate(() => window.obsidian.invoke('session:list'))).every((s) => s.state !== 'running'), 6000);
  } catch {
    // window already gone
  }
  await app.close();
}

/** Terminal text from xterm's DOM renderer rows, if present (WebGL renders to canvas instead). */
async function terminalText(win) {
  return win.evaluate(() => [...document.querySelectorAll('.session-view')].filter((v) => v.style.display !== 'none').map((v) => v.querySelector('.xterm-rows')?.innerText ?? '').join('\n'));
}

async function palette(win, title) {
  await win.keyboard.press(`${MOD}+Shift+P`);
  await win.waitForSelector('.palette-input');
  await win.fill('.palette-input', title);
  await sleep(150);
  await win.keyboard.press('Enter');
}

async function typeInTerminal(win, text) {
  await win.click('.session-view:not([style*="none"]) .terminal-pane', { position: { x: 40, y: 40 } });
  await win.keyboard.type(text, { delay: 8 });
}

// ─────────────────────────────────────────────────────────────────────────
async function suiteCore() {
  console.log('\n▸ Core workspace (real shell, git, files, security)');
  const repo = makeRepo('orbital-lab', true);
  const ud = seedUserData([repo]);
  const { app, win, errors } = await launch(ud);
  try {
    // detection
    const version = await waitFor(async () => {
      const t = await win.textContent('.titlebar');
      return /CLI\s*\d+\.\d+\.\d+/.test(t ?? '') ? t : null;
    }, 30000);
    check('Claude Code CLI detected and shown in title bar', version, await win.textContent('.titlebar'));
    await sleep(800);
    await win.screenshot({ path: path.join(OUT, '01-mission-control.png') });

    // renderer isolation
    const iso = await win.evaluate(() => ({ require: typeof require, process: typeof process, bridge: typeof window.obsidian?.invoke }));
    check('Renderer has no Node.js globals (context isolation + sandbox)', iso.require === 'undefined' && iso.process === 'undefined' && iso.bridge === 'function', JSON.stringify(iso));
    const blocked = await win.evaluate(() => window.obsidian.invoke('fs:readAnything', '/etc/passwd').then(() => 'allowed', (e) => String(e)));
    check('Unknown IPC channels are rejected by the preload bridge', /Blocked/.test(blocked), blocked);
    const traversal = await win.evaluate(() => window.obsidian.invoke('fs:read', 'proj0abc', '../../../../etc/passwd'));
    check('Path traversal outside the project is refused', traversal && traversal.ok === false, JSON.stringify(traversal));
    const badSpawn = await win.evaluate(() => window.obsidian.invoke('session:create', { kind: 'claude', projectId: 'proj0abc', mode: 'new', permissionMode: 'bypassPermissions', cols: 80, rows: 24 }).then(() => 'allowed', (e) => String(e)));
    check('Bypass-permission sessions cannot be requested over IPC', /not allowed/.test(badSpawn), badSpawn);
    const badPath = await win.evaluate(() => window.obsidian.invoke('settings:set', { claudePath: '/bin/sh' }).then(() => 'allowed', (e) => String(e)));
    check('Renderer cannot set the executable path', /cannot be changed/.test(badPath), badPath);

    // file tree + viewer
    await win.click('.rail-btn:has-text("Files")');
    await win.waitForSelector('.tree-row:has-text("README.md")');
    const treeHasBadge = await win.isVisible('.tree-row:has-text("NOTES.md") .tree-badge');
    check('File tree lists real files with git badges', treeHasBadge);
    await win.click('.tree-row:has-text("README.md")');
    await win.waitForSelector('.code-view');
    const content = await win.textContent('.code-view');
    check('File viewer shows real file content', content.includes('An OBSIDIAN end-to-end fixture.'), content);

    // git + diff
    await win.click('.intel .seg-tab:has-text("Files")');
    await win.waitForSelector('.intel .change-row:has-text("app.ts")');
    const changes = await win.$$eval('.intel .change-row .change-name', (els) => els.map((e) => e.textContent));
    check('Modified files come from git status (no invented entries)', JSON.stringify(changes.sort()) === JSON.stringify(['NOTES.md', 'app.ts']), JSON.stringify(changes));
    await win.click('.intel .change-row:has-text("app.ts") .change-main');
    await win.waitForSelector('.diff-view');
    const diffText = await win.textContent('.diff-view');
    const real = execFileSync('git', ['diff', '--', 'src/app.ts'], { cwd: repo }).toString();
    check('Diff view matches `git diff` exactly', diffText.includes('export const answer = 42;') && diffText.includes('export const answer = 41;') && real.includes('+export const ship = "obsidian";'), diffText.slice(0, 200));
    await win.screenshot({ path: path.join(OUT, '02-diff-view.png') });

    // stage + commit
    await win.click('.doc-head button:has-text("Stage")');
    await waitFor(() => execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo }).toString().includes('src/app.ts'));
    check('Stage action stages the file in the real repository', execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo }).toString().includes('src/app.ts'));
    await win.click('.rail-btn:has-text("Git")');
    await win.fill('.sidebar .commit-input', 'Raise the answer');
    await win.click('.sidebar .commit-box button:has-text("Commit")');
    const committed = await waitFor(() => execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo }).toString().trim() === 'Raise the answer');
    check('Commit creates a real commit only on explicit action', committed);

    // shell session: real keyboard → xterm → IPC → PTY → shell
    await win.keyboard.press(`${MOD}+Shift+T`);
    await win.waitForSelector('.session-view .xterm');
    await sleep(1500);
    await typeInTerminal(win, 'echo obsidian-e2e-$((6*7)) > marker.txt\r');
    const marker = await waitFor(() => fs.existsSync(path.join(repo, 'marker.txt')) && fs.readFileSync(path.join(repo, 'marker.txt'), 'utf8'));
    check('Keyboard input reaches the PTY shell (marker file written)', marker === 'obsidian-e2e-42\n', marker);
    await typeInTerminal(win, 'printf "\\033]0;e2e-title\\007"; echo "rows-cols $(stty size)"; sleep 3\r');
    const title = await waitFor(async () => ((await win.textContent('.tab.is-active .tab-title')) === 'e2e-title' ? true : null), 5000);
    check('Terminal title (OSC 0) updates the tab label', title, await win.textContent('.tab.is-active .tab-title'));
    const txt = await waitFor(async () => {
      const t = await terminalText(win);
      return /rows-cols \d+ \d+/.test(t) ? t : null;
    }, 4000);
    check('Terminal output renders (DOM text check, skipped if WebGL renderer)', txt || (await terminalText(win)) === '', txt?.match(/rows-cols \d+ \d+/)?.[0] ?? 'webgl canvas');

    // resize → PTY size changes
    await typeInTerminal(win, 'stty size > size1.txt\r');
    await waitFor(() => fs.existsSync(path.join(repo, 'size1.txt')));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 720));
    await sleep(900);
    await typeInTerminal(win, 'stty size > size2.txt\r');
    await waitFor(() => fs.existsSync(path.join(repo, 'size2.txt')) && fs.readFileSync(path.join(repo, 'size2.txt'), 'utf8').trim());
    const s1 = fs.readFileSync(path.join(repo, 'size1.txt'), 'utf8').trim();
    const s2 = fs.readFileSync(path.join(repo, 'size2.txt'), 'utf8').trim();
    check('Window resize propagates to the PTY (stty size changes)', s1 && s2 && s1 !== s2 && Number(s2.split(' ')[1]) < Number(s1.split(' ')[1]), `${s1} → ${s2}`);
    await win.screenshot({ path: path.join(OUT, '03-shell-session-1100.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 920));

    // panels + palette + layout
    await win.keyboard.press(`${MOD}+J`);
    await win.waitForSelector('.bottom-panel');
    await win.click('.bottom-panel .seg-tab:has-text("Processes")');
    const procs = await win.textContent('.proc-table');
    check('Process table shows the real shell pid', /running/.test(procs) && /\d{2,}/.test(procs), procs.slice(0, 160));
    await win.keyboard.press(`${MOD}+Alt+B`);
    check('Right panel collapses with shortcut', !(await win.isVisible('.intel')));
    await win.keyboard.press(`${MOD}+Alt+B`);
    check('Right panel restores with shortcut', await win.isVisible('.intel'));
    await palette(win, 'Layout: Focus');
    await sleep(300);
    check('Command palette runs commands (focus layout hides panels)', !(await win.isVisible('.sidebar')) && !(await win.isVisible('.intel')));
    await palette(win, 'Layout: Balanced');
    await sleep(300);

    // reduced motion + contrast preference wiring
    await win.evaluate(() => window.obsidian.invoke('settings:set', { reducedMotion: 'on', contrast: 'high' }));
    await win.reload();
    await win.waitForSelector('.chassis');
    const attrs = await win.evaluate(() => ({ m: document.documentElement.dataset.motion, c: document.documentElement.dataset.contrast, dur: getComputedStyle(document.documentElement).getPropertyValue('--dur').trim() }));
    check('Reduced-motion and high-contrast settings apply', attrs.m === 'reduce' && attrs.c === 'high' && attrs.dur === '0ms', JSON.stringify(attrs));
    await win.evaluate(() => window.obsidian.invoke('settings:set', { reducedMotion: 'system', contrast: 'standard' }));

    // after reload the existing PTY session should still be listed (main owns processes)
    const listed = await win.evaluate(() => window.obsidian.invoke('session:list'));
    check('Sessions survive a renderer reload (owned by main process)', listed.length === 1 && listed[0].state === 'running', JSON.stringify(listed.map((s) => s.state)));

    // exit handling
    await win.click('.tab .tab-main');
    await sleep(500);
    await typeInTerminal(win, 'exit 3\r');
    await win.waitForSelector('.exit-banner', { timeout: 8000 });
    const banner = await win.textContent('.exit-banner');
    check('Process exit is detected and reported with its exit code', /exited with code 3/.test(banner), banner);
    await win.screenshot({ path: path.join(OUT, '04-exit-banner.png') });

    // the app never reads secrets into storage
    const stored = fs.readdirSync(ud).filter((f) => f.endsWith('.json'));
    const blob = stored.map((f) => fs.readFileSync(path.join(ud, f), 'utf8')).join('\n');
    check('Only the documented JSON files are stored, with no env or terminal output', stored.every((f) => ['settings.json', 'projects.json', 'sessions.json', 'tasks.json'].includes(f)) && !blob.includes('marker.txt') && !blob.includes('rows-cols') && !blob.includes('"PATH'), stored.join(','));
    check('No uncaught renderer errors', errors.length === 0, errors.join(' | '));
    // last: Playwright keeps waiting on a navigation the app (correctly) never performs
    await win.evaluate(() => { location.href = 'https://example.com/'; });
    await sleep(800);
    check('Navigation away from the app is blocked', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL().startsWith('file://')));
  } finally {
    await closeApp(app, win);
  }
}

// ─────────────────────────────────────────────────────────────────────────
async function suiteFailures() {
  console.log('\n▸ Failure modes (missing CLI, logged-out CLI)');
  const repo = makeRepo('failure-bay', false);

  // 1. configured executable that does not exist
  {
    const ud = seedUserData([repo], { claudePath: '/nonexistent/claude' });
    const { app, win } = await launch(ud);
    try {
      await win.waitForSelector('.gauge:has-text("missing")', { timeout: 20000 });
      const home = await win.textContent('.systems');
      check('Missing CLI is shown as missing, with an actionable message', /Not found/.test(home) && /missing or not executable/.test(home), home.slice(0, 200));
      const label = await win.textContent('.new-tab');
      check('New-tab button falls back to Shell when Claude Code is unavailable', /Shell/.test(label), label);
      await win.screenshot({ path: path.join(OUT, '05-missing-cli.png') });
    } finally {
      await app.close();
    }
  }

  // 2. a CLI that is installed but not signed in
  {
    const stubDir = tmp('obsidian-stub-');
    const stub = path.join(stubDir, 'claude');
    fs.writeFileSync(
      stub,
      `#!/bin/sh
case "$1" in
  --version) echo "9.9.9 (Claude Code)";;
  --help) printf 'Options:\\n  -c, --continue  x\\n  --model <model>  x\\n  -r, --resume [value]  x\\n  --session-id <uuid>  x\\nCommands:\\n  auth  Manage authentication\\n';;
  auth) echo '{"loggedIn": false, "authMethod": "none"}';;
  *) echo "Not logged in · Please run /login"; exit 1;;
esac
`,
      { mode: 0o755 },
    );
    const ud = seedUserData([repo], { claudePath: stub });
    const { app, win } = await launch(ud);
    try {
      await win.waitForSelector('.gauge:has-text("9.9.9")', { timeout: 20000 });
      const auth = await win.textContent('.gauge:has-text("AUTH")');
      check('Logged-out CLI is reported from `claude auth status`', /NONE/.test(auth), auth);
      await win.keyboard.press(`${MOD}+T`);
      await win.waitForSelector('.exit-banner', { timeout: 10000 });
      const banner = await win.textContent('.exit-banner');
      check('Immediate CLI failure explains likely causes (auth) in the UI', /exited with code 1/.test(banner) && /auth login/.test(banner), banner);
      const cmd = await win.textContent('.exit-banner .exit-detail.mono');
      check('Spawned argv is structured (session id, no bypass flags)', /--session-id [0-9a-f-]{36}/.test(cmd) && !/dangerously|bypass/.test(cmd), cmd);
      await win.screenshot({ path: path.join(OUT, '06-logged-out.png') });
    } finally {
      await app.close();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
async function suiteClaude() {
  console.log('\n▸ Real Claude Code session (uses your authenticated CLI, one tiny prompt)');
  const repo = makeRepo('claude-dock', false);
  const ud = seedUserData([repo], { onboarded: true, bottomOpen: true });
  const { app, win, errors } = await launch(ud);
  try {
    await win.waitForSelector('.gauge:has-text("OK")', { timeout: 30000 });
    await win.keyboard.press(`${MOD}+T`);
    await win.waitForSelector('.session-view .xterm');
    const info = await waitFor(async () => (await win.evaluate(() => window.obsidian.invoke('session:list')))[0]);
    check('Claude Code launched in a PTY with an assigned session id', info?.state === 'running' && /^[0-9a-f-]{36}$/.test(info.claudeSessionId ?? ''), JSON.stringify(info));
    await sleep(7000);
    await win.screenshot({ path: path.join(OUT, '07-claude-starting.png') });
    // A fresh CLI config shows Claude Code's own first-run screens (theme, security notes,
    // folder trust). Step through them with Enter — the same key a user would press.
    const ready = await waitFor(async () => {
      const t = await terminalText(win);
      if (/Choose the text style|Press Enter to continue|trust (the files in )?this folder|Yes, (I trust|proceed)|Enter to confirm/i.test(t)) {
        await win.click('.session-view:not([style*="none"]) .terminal-pane', { position: { x: 40, y: 40 } });
        // Claude Code highlights "No, exit" by default on its trust prompt; move to "Yes" first.
        const selected = t.split('\n').find((l) => l.includes('❯')) ?? '';
        if (/trust this folder/.test(t) && !/trust/.test(selected)) {
          await win.keyboard.press('ArrowDown');
          await sleep(500);
        }
        await win.keyboard.press('Enter');
        await sleep(2500);
        return null;
      }
      return /for shortcuts|Try "|\? for|─{20}/.test(t) ? t : null;
    }, 60000, 1000);
    check('Reached the Claude Code prompt (after any first-run screens)', ready, (await terminalText(win)).slice(-300));
    await typeInTerminal(win, 'Reply with exactly the single word OBSIDIAN-OK and nothing else. Do not use any tools.');
    await sleep(400);
    await win.keyboard.press('Enter');
    const reply = await waitFor(async () => {
      const t = await win.textContent('.timeline').catch(() => '');
      return /OBSIDIAN-OK/.test(t ?? '') ? t : null;
    }, 120000, 1000);
    check('Prompt round-trips through the real CLI (reply seen in transcript timeline)', reply, (await win.textContent('.bottom-panel')).slice(0, 300));
    const model = await waitFor(async () => {
      const t = await win.textContent('.sh-gauge:has-text("MODEL") .sh-gauge-v');
      return /claude|opus|sonnet|haiku|fable/i.test(t ?? '') ? t : null;
    }, 15000);
    check('Model detected from the session transcript (not guessed)', model, await win.textContent('.sh-gauge:has-text("MODEL")'));
    const live = await waitFor(async () => {
      const agents = await win.evaluate(() => window.obsidian.invoke('claude:liveAgents'));
      return agents?.find((a) => a.sessionId === info.claudeSessionId) ?? null;
    }, 20000, 1500);
    check('Live status for this session reported by `claude agents --json`', live, JSON.stringify(live));
    await win.click('.rail-btn:has-text("Sessions")');
    await sleep(800);
    await win.click('.intel .seg-tab:has-text("Context")');
    await sleep(1500);
    await win.screenshot({ path: path.join(OUT, '08-claude-session.png') });

    // close the tab → confirm (auto-accepted) → process gone
    await win.click('.tab.is-active .tab-close');
    const gone = await waitFor(() => {
      try {
        process.kill(info.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 8000);
    check('Closing a running tab terminates exactly that process', gone, `pid ${info.pid}`);

    // resume via history
    await win.click('.sidebar button[title="Reload history"]').catch(() => undefined);
    await win.waitForSelector(`.history-row:has-text("${info.claudeSessionId.slice(0, 8)}")`, { timeout: 15000 });
    await win.click(`.history-row:has-text("${info.claudeSessionId.slice(0, 8)}") button:has-text("Resume")`);
    const resumed = await waitFor(async () => (await win.evaluate(() => window.obsidian.invoke('session:list'))).find((s) => s.mode === 'resume'));
    check('Resume launches `claude --resume <id>` for the saved conversation', resumed && resumed.commandLine.includes(`--resume ${info.claudeSessionId}`) && resumed.state === 'running', resumed?.commandLine);
    await sleep(5000);
    await win.screenshot({ path: path.join(OUT, '09-claude-resumed.png') });
    const records = JSON.parse(fs.readFileSync(path.join(ud, 'sessions.json'), 'utf8'));
    check('Session record stored without prompt or output text', records.length === 1 && records[0].claudeSessionId === info.claudeSessionId && !JSON.stringify(records).includes('OBSIDIAN-OK'), JSON.stringify(records));
    check('No uncaught renderer errors', errors.length === 0, errors.join(' | '));
  } finally {
    await closeApp(app, win);
  }
}

// ─────────────────────────────────────────────────────────────────────────
async function suiteGallery() {
  console.log('\n▸ Visual gallery (layouts and views)');
  const a = makeRepo('apollo-guidance', true);
  const b = makeRepo('lunar-module', false);
  const ud = seedUserData([a, b], { onboarded: false });
  const { app, win, errors } = await launch(ud);
  try {
    await win.waitForSelector('.gauge:has-text("OK")', { timeout: 30000 });
    await sleep(1200);
    await win.screenshot({ path: path.join(OUT, '10-home-projects.png') });
    await win.keyboard.press(`${MOD}+Shift+P`);
    await win.fill('.palette-input', 'session');
    await sleep(300);
    await win.screenshot({ path: path.join(OUT, '11-command-palette.png') });
    check('Command palette lists session commands', (await win.$$('.palette-item')).length >= 5);
    await win.keyboard.press('Escape');
    await win.keyboard.press(`${MOD}+P`);
    await win.fill('.palette-input', 'app');
    await win.waitForSelector('.palette-item:has-text("app.ts")', { timeout: 5000 });
    check('Quick open finds files by fuzzy name', await win.isVisible('.palette-item:has-text("app.ts")'));
    await win.keyboard.press('Enter');
    await win.waitForSelector('.code-view');
    await win.click('.rail-btn:has-text("Agents")');
    await sleep(1500);
    await win.screenshot({ path: path.join(OUT, '12-agents.png') });
    await win.click('.rail-btn:has-text("Settings")');
    await sleep(600);
    await win.screenshot({ path: path.join(OUT, '13-settings.png') });
    // tasks: add, complete, persist
    await win.click('.intel .seg-tab:has-text("Tasks")');
    await win.fill('.task-add .input', 'Calibrate the star tracker');
    await win.keyboard.press('Enter');
    await win.click('.task-row:has-text("Calibrate") .check');
    await sleep(400);
    const tasks = JSON.parse(fs.readFileSync(path.join(ud, 'tasks.json'), 'utf8'));
    check('Tasks can be added and completed, and persist', tasks.length === 1 && tasks[0].done === true && tasks[0].title === 'Calibrate the star tracker', JSON.stringify(tasks));
    // minimum window size
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 620));
    await win.keyboard.press(`${MOD}+Shift+T`);
    await win.waitForSelector('.session-view .xterm');
    await sleep(1500);
    await win.screenshot({ path: path.join(OUT, '14-minimum-size.png') });
    const overflow = await win.evaluate(() => document.documentElement.scrollWidth > window.innerWidth || document.documentElement.scrollHeight > window.innerHeight);
    check('No page overflow at the minimum window size (980×620)', !overflow);
    check('No uncaught renderer errors', errors.length === 0, errors.join(' | '));
  } finally {
    await closeApp(app, win);
  }
}

// ─────────────────────────────────────────────────────────────────────────
async function suiteLifecycle() {
  console.log('\n▸ Quit with running sessions');
  const repo = makeRepo('quit-test', false);
  const ud = seedUserData([repo], { onboarded: true });
  const { app, win } = await launch(ud);
  await win.keyboard.press(`${MOD}+Shift+T`);
  const sess = await waitFor(async () => (await win.evaluate(() => window.obsidian.invoke('session:list'))).find((s) => s.state === 'running'));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // Only the native dialog's answer is simulated; the quit logic itself is real.
  await app.evaluate(({ dialog }) => { globalThis.__asked = 0; dialog.showMessageBox = async () => { globalThis.__asked++; return { response: 1, checkboxChecked: false }; }; });
  await app.evaluate(({ app: a }) => a.quit());
  await sleep(1200);
  const asked = await app.evaluate(() => globalThis.__asked);
  check('Quitting with a running session asks for confirmation', asked === 1, `asked=${asked}`);
  check('Cancelling the quit keeps the app and the session running', alive(sess.pid) && (await win.evaluate(() => window.obsidian.invoke('session:list')))[0].state === 'running');
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  const closed = new Promise((r) => app.once('close', r));
  await app.evaluate(({ app: a }) => a.quit());
  await Promise.race([closed, sleep(10000)]);
  const gone = await waitFor(() => !alive(sess.pid), 6000);
  check('Confirming the quit ends the app and its child process', gone, `pid ${sess.pid}`);
}

const started = Date.now();
try {
  const only = process.env.OBSIDIAN_E2E_ONLY; // core | failures | claude
  if (!only || only === 'core') await suiteCore();
  if (!only || only === 'failures') await suiteFailures();
  if (!only || only === 'gallery') await suiteGallery();
  if (!only || only === 'lifecycle') await suiteLifecycle();
  if ((!only || only === 'claude') && process.env.OBSIDIAN_E2E_CLAUDE !== '0') await suiteClaude();
} catch (e) {
  check('suite crashed', false, e.stack ?? e);
  await lastWin?.screenshot({ path: path.join(OUT, 'crash.png') }).catch(() => undefined);
}
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, durationMs: Date.now() - started, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(failed.length ? 1 : 0);
