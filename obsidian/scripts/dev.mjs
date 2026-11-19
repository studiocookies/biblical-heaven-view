// Dev loop: Vite dev server for the renderer, esbuild watch for main/preload, then Electron.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls.local[0];

const esb = spawn(process.execPath, ['scripts/build-main.mjs', '--watch'], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1200));

const electronPath = (await import('electron')).default;
const app = spawn(electronPath, ['.'], { stdio: 'inherit', env: { ...process.env, OBSIDIAN_DEV_URL: url } });
app.on('exit', async (code) => {
  esb.kill();
  await server.close();
  process.exit(code ?? 0);
});
