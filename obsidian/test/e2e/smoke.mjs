// Quick visual smoke test: launch, wait, screenshot.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire('/opt/node22/lib/node_modules/');
const { _electron } = require('playwright');
const electronPath = (await import('electron')).default;

const out = process.argv[2] ?? 'test/e2e/artifacts';
fs.mkdirSync(out, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-smoke-'));
const app = await _electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, OBSIDIAN_USER_DATA: userData } });
const win = await app.firstWindow();
win.on('console', (m) => console.log('[renderer]', m.type(), m.text()));
win.on('pageerror', (e) => console.log('[pageerror]', e.message));
await win.waitForSelector('.chassis', { timeout: 20000 });
await win.waitForTimeout(4000);
await win.screenshot({ path: path.join(out, 'smoke-home.png') });
console.log('title', await win.title());
await app.close();
