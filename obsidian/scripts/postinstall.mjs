// node-pty's macOS prebuilds ship `spawn-helper` without the executable bit, which makes every
// spawn fail with "posix_spawnp failed". Restore it after install.
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(process.cwd(), 'node_modules', 'node-pty');
const candidates = [path.join(root, 'build', 'Release', 'spawn-helper')];
try {
  for (const dir of fs.readdirSync(path.join(root, 'prebuilds'))) candidates.push(path.join(root, 'prebuilds', dir, 'spawn-helper'));
} catch {
  // no prebuilds directory (built from source)
}
for (const file of candidates) {
  try {
    const mode = fs.statSync(file).mode;
    if ((mode & 0o111) !== 0o111) {
      fs.chmodSync(file, mode | 0o755);
      console.log(`[obsidian] made executable: ${path.relative(process.cwd(), file)}`);
    }
  } catch {
    // file absent for this platform
  }
}
