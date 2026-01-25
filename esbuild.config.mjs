// @ts-check
import * as esbuild from 'esbuild';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Path aliases matching tsconfig.json
 */
const aliases = {
  '@': path.resolve(__dirname, 'src'),
  '~': path.resolve(__dirname, 'src'),
  '@common': path.resolve(__dirname, 'src/common'),
  '@webview': path.resolve(__dirname, 'src/webview'),
  '@agent': path.resolve(__dirname, 'src/agent'),
  '@frontend': path.resolve(__dirname, 'src/frontend'),
  '@utils': path.resolve(__dirname, 'src/utils'),
  '@logger': path.resolve(__dirname, 'src/logger'),
  '@latex': path.resolve(__dirname, 'src/latex'),
  '@commands': path.resolve(__dirname, 'src/commands'),
  '@model': path.resolve(__dirname, 'src/model'),
  '@housekeeping': path.resolve(__dirname, 'src/housekeeping'),
  '@shared': path.resolve(__dirname, 'src/shared'),
  '@progressView': path.resolve(__dirname, 'src/progressView'),
  '@historyView': path.resolve(__dirname, 'src/historyView'),
  '@memoryView': path.resolve(__dirname, 'src/memoryView'),
  '@profileView': path.resolve(__dirname, 'src/profileView'),
  '@replacement': path.resolve(__dirname, 'src/replacement'),
  '@tools': path.resolve(__dirname, 'src/tools'),
  '@types': path.resolve(__dirname, 'src/types'),
  '@eventBus': path.resolve(__dirname, 'src/eventBus'),
  '@auth': path.resolve(__dirname, 'src/auth'),
};

// Sort aliases by length (longest first) to avoid partial matches
const sortedAliases = Object.entries(aliases).sort(
  ([a], [b]) => b.length - a.length
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
        console.error(`[esbuild] Build failed with ${result.errors.length} errors`);
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
  treeShaking: true,
  // Let esbuild resolve .ts files
  resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  external: [
    'vscode', // VS Code API - provided at runtime
    'fsevents', // macOS native module
    'bufferutil', // Optional native module
    'utf-8-validate', // Optional native module
  ],
  plugins: [aliasPlugin, progressPlugin],
  logLevel: 'warning',
  define: {
    'process.env.NODE_ENV': production ? '"production"' : '"development"',
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
