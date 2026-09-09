import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';

import { defineConfig } from 'vitest/config';

import { aliases, rootDir } from './scripts/aliases.mjs';

const require = createRequire(import.meta.url);
const QUICKJS_WASM_ID = '@jitl/quickjs-wasmfile-release-sync/wasm';
const QUICKJS_WASM_VIRTUAL_ID = '\0texra-quickjs-wasm';
const quickJsWasmPath = require.resolve(QUICKJS_WASM_ID);
// Full Windows shards intermittently exceed 10s in unrelated suites; retain the
// tighter timeout elsewhere so genuine local/Linux hangs fail fast. Windows CI
// is opt-in (see the `test` job in .github/workflows/ci.yml), so this branch
// still applies to on-demand runs and to local runs on Windows.
const kernelTimeoutMs = process.platform === 'win32' ? 20_000 : 10_000;

export default defineConfig({
  plugins: [texTemplatePlugin(), quickJsWasmPlugin()],
  resolve: {
    alias: {
      ...aliases,
      electron: `${rootDir}/src/test-kernel/desktop/electronTestStub.ts`,
      // Suites exercising VS Code-coupled modules run against this minimal
      // stub; inside the real extension host the genuine module wins.
      vscode: `${rootDir}/src/test-kernel/support/vscode-mock.ts`,
    },
  },
  test: {
    environment: 'node',
    ...(process.env.TEXRA_TEST_NODE
      ? { pool: executablePool(process.env.TEXRA_TEST_NODE) }
      : {}),
    include: ['src/test-kernel/**/*.vitest.ts'],
    passWithNoTests: false,
    setupFiles: ['src/test-kernel/support/setupFakePlatform.ts'],
    testTimeout: kernelTimeoutMs,
    hookTimeout: kernelTimeoutMs,
  },
});

function texTemplatePlugin() {
  return {
    name: 'tex-template-loader',
    transform(_source, id) {
      if (!id.endsWith('.tex')) return undefined;

      const contents = readFileSync(id, 'utf8');
      return {
        code: `export default ${JSON.stringify(contents)};`,
        map: null,
      };
    },
  };
}

function quickJsWasmPlugin() {
  return {
    name: 'quickjs-wasm-loader',
    enforce: 'pre',
    resolveId(source) {
      if (source === QUICKJS_WASM_ID) return QUICKJS_WASM_VIRTUAL_ID;
      return undefined;
    },
    load(id) {
      if (id !== QUICKJS_WASM_VIRTUAL_ID) return undefined;

      const contents = readFileSync(quickJsWasmPath);
      return {
        code: `export default Uint8Array.from(Buffer.from(${JSON.stringify(contents.toString('base64'))}, 'base64'));`,
        map: null,
      };
    },
  };
}

/** Transform on the tool host and execute the unchanged suite on the requested Node host. */
function executablePool(execPath) {
  return {
    name: 'node-executable',
    createPoolWorker(options) {
      let child;
      return {
        name: 'node-executable',
        async start() {
          child = fork(resolve(options.distPath, 'workers/forks.js'), [], {
            execPath,
            execArgv: options.execArgv,
            env: options.env,
            serialization: 'advanced',
            stdio: 'pipe',
          });
          child.stdout.pipe(options.project.vitest.logger.outputStream, {
            end: false,
          });
          child.stderr.pipe(options.project.vitest.logger.errorStream, {
            end: false,
          });
        },
        on(event, listener) {
          child.on(event, listener);
        },
        off(event, listener) {
          child.off(event, listener);
        },
        send(message) {
          child.send(message);
        },
        deserialize(value) {
          return value;
        },
        async stop() {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const exited = once(child, 'exit');
          child.kill();
          await exited;
        },
      };
    },
  };
}
