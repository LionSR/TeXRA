import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Shared path aliases from tsconfig.json (single source of truth)
import { aliases } from '../../scripts/aliases.mjs';

// Each webview's entry module: the progress view renders from the app's UI
// kit, the settings view from this package.
const webviewEntries = {
  progressView: '../texra/src/ui/progress/index.ts',
  settingsView: 'src/settingsView/frontend/index.ts',
} as const;

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
  if (!webviewName || !Object.hasOwn(webviewEntries, webviewName)) {
    throw new Error(
      `VITE_WEBVIEW must name a webview (${Object.keys(webviewEntries).join(', ')}), got: ${
        webviewName ?? '<unset>'
      }`,
    );
  }

  return {
    // Use relative paths for assets (required for VS Code webviews)
    base: './',
    build: {
      // One directory per webview, emptied by its own build; extension.js
      // sits beside them in dist/ untouched.
      outDir: `dist/${webviewName}`,
      emptyOutDir: true,
      sourcemap: isDev ? 'inline' : false,
      minify: isDev ? false : 'esbuild',
      target: 'es2022',
      // Each webview is intentionally a single bundle for the nonce-only CSP.
      // Keep a tight budget above the largest current production bundle.
      chunkSizeWarningLimit: 3000,
      // Disable asset inlining to ensure all fonts are emitted as files (not base64 data URIs)
      // This is required because VS Code webview CSP font-src doesn't allow data: URIs
      // Note: KaTeX_Size3-Regular.woff2 (3.6KB) would otherwise be inlined and blocked by CSP
      assetsInlineLimit: 0,
      rollupOptions: {
        input: resolve(
          import.meta.dirname,
          webviewEntries[webviewName as keyof typeof webviewEntries],
        ),
        output: {
          // Single self-contained bundle per webview
          entryFileNames: 'bundle.js',
          assetFileNames: '[name][extname]',
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
