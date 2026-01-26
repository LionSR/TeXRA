import { defineConfig } from 'vite';
import { resolve } from 'path';

// Shared path aliases from tsconfig.json (single source of truth)
// @ts-expect-error - .mjs import works at runtime via Vite's ESM handling
import { aliases } from './scripts/aliases.mjs';

const webviews = [
  'progressView',
  'memoryView',
  'historyView',
  'profileView',
  'webview',
] as const;

/**
 * Build configuration for a single webview.
 * Each webview is built independently to produce a self-contained bundle
 * that works with VS Code's nonce-only CSP (no external chunk imports).
 */
function createWebviewConfig(webviewName: string, isDev: boolean) {
  return {
    // Use relative paths for assets (required for VS Code webviews)
    base: './',
    build: {
      outDir: 'dist',
      emptyOutDir: false, // Don't clear dist (extension.js lives there)
      sourcemap: isDev ? 'inline' : false,
      minify: isDev ? false : 'esbuild',
      target: 'es2022',
      // Keep default 4KB limit - fonts above this are emitted as files (not inlined as base64)
      // KaTeX fonts are ~10-60KB each, so they will be emitted to dist/{webview}/
      assetsInlineLimit: 4 * 1024,
      rollupOptions: {
        input: resolve(__dirname, `src/${webviewName}/frontend/index.ts`),
        output: {
          // Single self-contained bundle per webview
          entryFileNames: `${webviewName}/bundle.js`,
          assetFileNames: `${webviewName}/[name][extname]`,
          // Inline all imports - required for nonce-only CSP
          inlineDynamicImports: true,
        },
      },
    },
    resolve: { alias: aliases },
    define: {
      'process.env.NODE_ENV': JSON.stringify(
        isDev ? 'development' : 'production',
      ),
    },
    esbuild: { keepNames: true, target: 'es2022' },
  };
}

/**
 * Get the webview to build from VITE_WEBVIEW env var.
 * Usage: VITE_WEBVIEW=progressView npm run vite:build
 * If not specified, defaults to building all webviews sequentially via npm script.
 */
const targetWebview = process.env.VITE_WEBVIEW as
  | (typeof webviews)[number]
  | undefined;

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';

  // If a specific webview is targeted, build just that one
  if (targetWebview && webviews.includes(targetWebview)) {
    return createWebviewConfig(targetWebview, isDev);
  }

  // Default config (used when no specific webview is targeted)
  // Note: For production builds, use the npm script that builds each webview separately
  return {
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      sourcemap: isDev ? 'inline' : false,
      minify: isDev ? false : 'esbuild',
      target: 'es2022',
      assetsInlineLimit: 4 * 1024,
    },

    resolve: { alias: aliases },
    define: {
      'process.env.NODE_ENV': JSON.stringify(
        isDev ? 'development' : 'production',
      ),
    },
    css: { devSourcemap: isDev },
    esbuild: { keepNames: true, target: 'es2022' },
    optimizeDeps: {
      include: ['lit', 'zod', 'katex'],
      exclude: ['vscode'],
    },
  };
});

/** Export webview names for use in build scripts */
export { webviews };
