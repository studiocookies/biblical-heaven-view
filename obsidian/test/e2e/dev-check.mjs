// Verifies the dev loop: Vite dev server + Electron loading it with the dev CSP and origin checks.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = createRequire('/opt/node22/lib/node_modules/')('playwright'); }
const electronPath = (await import('electron')).default;
const server = await createServer({ configFile: 'vite.config.ts', logLevel: 'silent' });
await server.listen();
const url = server.resolvedUrls.local[0];
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-dev-'));
const app = await pw._electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, OBSIDIAN_DEV_URL: url, OBSIDIAN_USER_DATA: ud } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('.chassis', { timeout: 30000 });
const settings = await win.evaluate(() => window.obsidian.invoke('settings:get'));
console.log(JSON.stringify({ url: win.url(), bridge: !!settings?.shortcuts, errors }));
await app.close();
await server.close();
process.exit(settings?.shortcuts && errors.length === 0 ? 0 : 1);
