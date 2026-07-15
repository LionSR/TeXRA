// @ts-check
import * as esbuild from 'esbuild';
import * as path from 'path';
import * as fs from 'fs';

// Shared path aliases from tsconfig.json (single source of truth)
import { aliases } from '../../scripts/aliases.mjs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Sort aliases by length (longest first) to avoid partial matches
const sortedAliases = Object.entries(aliases).sort(
  ([a], [b]) => b.length - a.length,
);

/**
 * Resolve a path with TypeScript extensions
 */
function resolveWithExtensions(basePath) {
  const extensions = ['.ts', '.tsx', '.js', '.jsx', ''];

  // Try as-is first (for paths that already have extension)
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
    return basePath;
  }

  // Try with extensions
  for (const ext of extensions) {
    const withExt = basePath + ext;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }

  // Try as directory with index file
  if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    for (const ext of extensions) {
      const indexPath = path.join(basePath, 'index' + ext);
      if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
        return indexPath;
      }
    }
  }

  return null;
}

/**
 * Plugin to resolve path aliases with TypeScript support
 */
const aliasPlugin = {
  name: 'alias',
  setup(build) {
    build.onResolve({ filter: /^[@~]/ }, (args) => {
      for (const [alias, target] of sortedAliases) {
        if (args.path === alias || args.path.startsWith(alias + '/')) {
          const resolved = args.path.replace(alias, target);
          const finalPath = resolveWithExtensions(resolved);

          if (finalPath) {
            return { path: finalPath };
          }

          // Let esbuild handle unresolved paths (will show error)
          return { path: resolved };
        }
      }
      return null;
    });
  },
};

/**
 * Plugin to log build progress
 */
const progressPlugin = {
  name: 'progress',
  setup(build) {
    let startTime;
    build.onStart(() => {
      startTime = Date.now();
      console.log('[esbuild] Building extension...');
    });
    build.onEnd((result) => {
      const duration = Date.now() - startTime;
      if (result.errors.length > 0) {
        console.error(
          `[esbuild] Build failed with ${result.errors.length} errors`,
        );
      } else {
        console.log(`[esbuild] Extension built in ${duration}ms`);
      }
    });
  },
};

/**
 * Extension host build configuration
 */
const extensionConfig = {
  entryPoints: ['./src/extension.ts'],
  bundle: true,
  outfile: './dist/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: production ? false : 'linked',
  minify: production,
  // sdkErrorUtils relies on SDK error class/prototype names after bundling.
  keepNames: production,
  treeShaking: true,
  // Let esbuild resolve .ts files
  resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  external: [
    'vscode', // VS Code API - provided at runtime
    'fsevents', // macOS native module
    'bufferutil', // Optional native module
    'utf-8-validate', // Optional native module
  ],
  loader: { '.tex': 'text', '.wasm': 'binary' },
  plugins: [aliasPlugin, progressPlugin],
  logLevel: 'warning',
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
