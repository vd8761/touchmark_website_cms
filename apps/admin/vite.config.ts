import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@cms/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Same-origin in development so the session cookies behave exactly as
      // they will in production behind the edge.
      '/admin': { target: 'http://localhost:4000', changeOrigin: true },
      '/v1': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
});
