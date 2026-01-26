import { defineConfig } from 'vite';
import { resolve } from 'path';

const webviews = [
  'progressView',
  'memoryView',
  'historyView',
  'profileView',
  'webview',
] as const;

/**
 * Path aliases matching tsconfig.json
 */
const aliases = {
  '@': resolve(__dirname, 'src'),
  '~': resolve(__dirname, 'src'),
  '@common': resolve(__dirname, 'src/common'),
  '@webview': resolve(__dirname, 'src/webview'),
  '@agent': resolve(__dirname, 'src/agent'),
  '@frontend': resolve(__dirname, 'src/frontend'),
  '@utils': resolve(__dirname, 'src/utils'),
  '@logger': resolve(__dirname, 'src/logger'),
  '@latex': resolve(__dirname, 'src/latex'),
  '@commands': resolve(__dirname, 'src/commands'),
  '@model': resolve(__dirname, 'src/model'),
  '@housekeeping': resolve(__dirname, 'src/housekeeping'),
  '@shared': resolve(__dirname, 'src/shared'),
  '@progressView': resolve(__dirname, 'src/progressView'),
  '@historyView': resolve(__dirname, 'src/historyView'),
  '@memoryView': resolve(__dirname, 'src/memoryView'),
  '@profileView': resolve(__dirname, 'src/profileView'),
  '@replacement': resolve(__dirname, 'src/replacement'),
  '@tools': resolve(__dirname, 'src/tools'),
  '@types': resolve(__dirname, 'src/types'),
  '@eventBus': resolve(__dirname, 'src/eventBus'),
  '@auth': resolve(__dirname, 'src/auth'),
};

/**
 * Generate entry points for all webviews
 */
const input = Object.fromEntries(
  webviews.map((name) => [name, resolve(__dirname, `src/${name}/frontend/index.ts`)])
);

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';

  return {
    // Lit works best with ESM
    build: {
      // Output to dist folder matching webpack structure
      outDir: 'dist',
      emptyOutDir: false, // Don't clear dist (extension.js lives there)
      sourcemap: isDev ? 'inline' : false,
      minify: isDev ? false : 'esbuild',
      target: 'es2022',

  // Keep default 4KB inline limit - don't inline fonts
      // Fonts are loaded separately via VS Code's webview URI system
      assetsInlineLimit: 4 * 1024,

      // Library mode for each webview
      rollupOptions: {
        input,
        output: {
          // Match webpack output structure: dist/{webview}/bundle.js
          entryFileNames: '[name]/bundle.js',
          chunkFileNames: 'shared/[name]-[hash].js',
          assetFileNames: '[name]/[name][extname]',

          // Inline dynamic imports to keep single bundle per webview
          inlineDynamicImports: false,

          // Create a shared vendor chunk for Lit and Zod
          manualChunks: {
            vendor: ['lit', 'zod'],
          },
        },
      },
    },

    resolve: {
      alias: aliases,
    },

    // Enable Lit's production mode in production builds
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
    },

    // CSS handling
    css: {
      devSourcemap: isDev,
    },

    // esbuild options for TypeScript
    esbuild: {
      // Keep class names for Lit components (decorators use them)
      keepNames: true,
      // Target modern browsers (VS Code webviews use Chromium)
      target: 'es2022',
    },

    // Dev server for HMR (optional - for standalone webview development)
    server: {
      port: 5173,
      strictPort: true,
      hmr: {
        port: 5173,
      },
    },

    // Optimize deps for faster dev startup
    optimizeDeps: {
      include: ['lit', 'zod', 'katex'],
      // Exclude VS Code-specific modules
      exclude: ['vscode'],
    },
  };
});
