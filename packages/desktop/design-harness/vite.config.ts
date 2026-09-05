import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { aliases } from '../../../scripts/aliases.mjs';

export default defineConfig({
  root: import.meta.dirname,
  server: {
    port: 5178,
    strictPort: true,
    fs: { allow: [resolve(import.meta.dirname, '../../..')] },
  },
  resolve: {
    alias: aliases,
    dedupe: [
      '@awesome.me/webawesome',
      '@lit/context',
      '@lit-labs/signals',
      'lit',
      'signal-polyfill',
    ],
  },
});
