import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Production CSP is strict. The dev server needs inline scripts for React refresh and a websocket for HMR.
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://localhost:*; object-src 'none'";

function csp(): Plugin {
  let dev = false;
  return {
    name: 'obsidian-csp',
    configResolved(c) {
      dev = c.command === 'serve';
    },
    transformIndexHtml(html) {
      return html.replace('%CSP%', dev ? DEV_CSP : PROD_CSP);
    },
  };
}

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), csp()],
  build: { outDir: '../../dist/renderer', emptyOutDir: true, target: 'chrome130', sourcemap: false, chunkSizeWarningLimit: 1500 },
  server: { port: 5199, strictPort: false },
});
