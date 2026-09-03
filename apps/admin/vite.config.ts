import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@cms/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    // `e2e/` holds Playwright specs, run by `npm run test:browser` from the
    // repo root. They use Playwright's own `test` object, so picking them up
    // here fails at collection rather than running anything.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
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
