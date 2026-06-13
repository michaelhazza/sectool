import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The SPA root is this `ui/` directory; built assets ship to `ui/dist`, which
// `src/ui/server.ts` (P7-1) serves as static assets under the `audit ui` server.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
  },
});
