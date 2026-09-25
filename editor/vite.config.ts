/**
 * Vite config for the Rev2D editor UI. The editor imports the Rev2D core straight from ../src (it
 * runs the same validator and evaluator as the CLI), so the dev server may read the whole repo.
 *
 *   npm run editor:dev    dev server with HMR; /api is proxied to an editor server on 127.0.0.1:4777
 *   npm run editor:build  production build into dist/editor (served by the editor server)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const editorRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(editorRoot, '..');

export default defineConfig({
  root: editorRoot,
  // Relative asset URLs: the built UI works wherever the server mounts it.
  base: './',
  plugins: [react()],
  build: {
    outDir: path.join(repoRoot, 'dist', 'editor'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:4777' },
    fs: { allow: [repoRoot] },
  },
});
