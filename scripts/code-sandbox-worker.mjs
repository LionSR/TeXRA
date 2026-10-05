// Embeds the code sandbox worker in the bundle that imports it. The import
// `virtual:code-sandbox-worker` resolves to the worker entry
// (packages/harness/src/agent/codeSandbox/worker.ts) bundled on its own as CommonJS source
// text, which the host starts with `new Worker(source, { eval: true })`.
//
// Embedding the text rather than emitting a second file is what the QuickJS
// WASM bytes already do (packages/harness/src/agent/codeSandbox/codeSandbox.ts): no host
// resolves a worker path at run time, so the extension's CJS bundle, the
// CLI's single ESM file, the desktop's split ESM chunks and the desktop's
// app.asar all start the same worker without a per-host lookup table.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CODE_SANDBOX_WORKER_ID = 'virtual:code-sandbox-worker';

/**
 * Bundles the worker entry. Returns its source text and the files it read,
 * so a watching build rebuilds when any of them changes.
 */
export async function bundleCodeSandboxWorker({ minify = false } = {}) {
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: ['packages/harness/src/agent/codeSandbox/worker.ts'],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    minify,
    // Error classification reads error names after bundling.
    keepNames: true,
    legalComments: 'none',
    logLevel: 'silent',
    // The QuickJS variant's ESM build calls `createRequire(import.meta.url)`,
    // which CommonJS output leaves undefined. An eval worker's `__filename`
    // is `[worker eval]`, which this resolves against the cwd: any absolute
    // URL serves, since the module only requires Node built-ins once it is
    // handed a compiled WASM module.
    banner: {
      js: 'var importMetaUrl = require("node:url").pathToFileURL(__filename).href;',
    },
    define: { 'import.meta.url': 'importMetaUrl' },
    tsconfig: resolve(repoRoot, 'tsconfig.json'),
  });
  return {
    source: result.outputFiles[0].text,
    inputs: Object.keys(result.metafile.inputs).map((input) =>
      resolve(repoRoot, input),
    ),
  };
}

/** @type {import('esbuild').Plugin} */
export const codeSandboxWorker = {
  name: 'code-sandbox-worker',
  setup(pluginBuild) {
    const minify = pluginBuild.initialOptions.minify === true;
    pluginBuild.onResolve({ filter: /^virtual:code-sandbox-worker$/ }, () => ({
      path: CODE_SANDBOX_WORKER_ID,
      namespace: 'code-sandbox-worker',
    }));
    pluginBuild.onLoad(
      { filter: /.*/, namespace: 'code-sandbox-worker' },
      async () => {
        const { source, inputs } = await bundleCodeSandboxWorker({ minify });
        return { contents: source, loader: 'text', watchFiles: inputs };
      },
    );
  },
};
