import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// One self-contained index.html (JS + CSS inlined): works on GitHub Pages, behind the
// climbritz.app/gioco rewrite, as a Claude artifact, or opened straight from disk.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: { target: 'es2020', outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: { port: 5173 },
});
