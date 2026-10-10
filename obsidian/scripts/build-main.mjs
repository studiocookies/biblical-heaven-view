// Bundles the Electron main process and preload script with esbuild.
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron', 'node-pty'],
  logLevel: 'info',
};
const configs = [
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' },
  // Sandboxed preloads can only require('electron'); everything else must be bundled in.
  { ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js', external: ['electron'] },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
