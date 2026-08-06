import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Shared path aliases from tsconfig.json (single source of truth)
import { aliases } from '../../scripts/aliases.mjs';

const webviews = ['progressView', 'settingsView', 'webview'] as const;

/**
 * Builds a single webview, named by VITE_WEBVIEW.
 * Usage: VITE_WEBVIEW=progressView vite build
 *
 * Each webview is built independently to produce a self-contained bundle
 * that works with VS Code's nonce-only CSP (no external chunk imports).
 */
export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';
  const webviewName = process.env.VITE_WEBVIEW;
  if (!webviewName || !(webviews as readonly string[]).includes(webviewName)) {
    throw new Error(
      `VITE_WEBVIEW must name a webview (${webviews.join(', ')}), got: ${
        webviewName ?? '<unset>'
      }`,
    );
  }

  return {
    // Use relative paths for assets (required for VS Code webviews)
    base: './',
    build: {
      outDir: 'dist',
      emptyOutDir: false, // Don't clear dist (extension.js lives there)
      sourcemap: isDev ? 'inline' : false,
      minify: isDev ? false : 'esbuild',
      target: 'es2022',
      // Disable asset inlining to ensure all fonts are emitted as files (not base64 data URIs)
      // This is required because VS Code webview CSP font-src doesn't allow data: URIs
      // Note: KaTeX_Size3-Regular.woff2 (3.6KB) would otherwise be inlined and blocked by CSP
      assetsInlineLimit: 0,
      rollupOptions: {
        input: resolve(
          import.meta.dirname,
          `src/${webviewName}/frontend/index.ts`,
        ),
        output: {
          // Single self-contained bundle per webview
          entryFileNames: `${webviewName}/bundle.js`,
          assetFileNames: `${webviewName}/[name][extname]`,
          // Inline all imports - required for nonce-only CSP
          codeSplitting: false,
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
});
