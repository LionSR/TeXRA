// @ts-check
import * as esbuild from 'esbuild';

import { harnessBundleOptions } from '../../scripts/code-sandbox-worker.mjs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const base = harnessBundleOptions();

/**
 * Extension host build configuration
 */
const extensionConfig = {
  ...base,
  entryPoints: ['./src/extension.ts'],
  outfile: './dist/extension.js',
  platform: 'node',
  // The Node of the Electron that runs VS Code's extension host, at the
  // `engines.vscode` floor: VS Code 1.125 ships Electron 42, on Node 24.15.
  target: 'node24.15',
  format: 'cjs',
  sourcemap: production ? false : 'linked',
  minify: production,
  tsconfig: './tsconfig.json',
  external: [
    'vscode', // VS Code API - provided at runtime
    'fsevents', // macOS native module
  ],
  loader: { ...base.loader, '.tex': 'text' },
  logLevel: 'info',
  // Polyfill import.meta.url for ESM-only dependencies (e.g. @openai/codex-sdk)
  // bundled into CJS. Without this, esbuild replaces import.meta with {} and
  // calls like createRequire(import.meta.url) throw at runtime.
  // The extension host bundle targets Node. Keep unqualified browser
  // `navigator` probes inside bundled dependencies on the Node path instead of
  // touching VS Code's deprecated extension-host navigator shim. Webview
  // bundles are built separately and keep the real browser navigator.
  banner: {
    js:
      `"use strict"; var navigator = undefined; ` +
      `var importMetaUrl = require("url").pathToFileURL(__filename).href;`,
  },
  define: {
    ...base.define,
    'process.env.NODE_ENV': production ? '"production"' : '"development"',
    'import.meta.url': 'importMetaUrl',
  },
};

async function main() {
  try {
    if (watch) {
      // Watch mode
      const ctx = await esbuild.context(extensionConfig);
      await ctx.watch();
      console.log('[esbuild] Watching for changes...');
    } else {
      // Single build
      await esbuild.build(extensionConfig);
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

main();
