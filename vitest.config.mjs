import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';

import { globSync } from 'glob';
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

// Suites are tiered by what they reach, and pay only for that.
//
// A suite's cost is its import closure evaluated once per file, so a suite of
// a pure function that never touches a host must not pay for the fake platform,
// the session runtime and everything behind them. The `pure` project runs the
// directories whose modules need no host: no setup file, and a module registry
// shared between files, which is safe there by construction — nothing in it
// installs process-wide state, so nothing can leak. Measured on 136 suites:
// 28s against 1m55s isolated, and deterministic.
//
// The `kernel` project is everything else: the fake host installed per file,
// each file in its own module registry, because module-scope state
// (`platform()`, the process runtime, `vi.mock` factories) still leaks between
// files when the registry is shared. It flips to `isolate: false` when the
// effect-migration ratchet counts reach zero for what these suites reach.
//
// Membership is computed from the suite's source, not declared: a suite under
// one of these directories is `pure` unless it mocks a repository module
// (`vi.mock` / `vi.doMock` — a partial factory left in a shared registry is
// what the next suite imports) or reaches a host (`@platform/*`, or the
// support modules that install one). Add a `vi.mock` and the suite moves to
// `kernel` on its own; remove it and the suite moves back. The tier's premise
// — nothing in it installs or replaces anything, so nothing can leak — is
// therefore true by construction, which is what makes the shared registry
// deterministic here. A directory earns a place in this list by holding
// suites of host-free modules; the scan decides file by file.
const PURE_DIRS = [
  'agent',
  'architecture',
  'auth',
  'cli',
  'commands',
  'common',
  'controllers',
  'latex',
  'llm',
  'logger',
  'model',
  'replacement',
  'schemas',
  'scripts',
  'shared',
  'skills',
  'telemetry',
  'tools',
  'traceViewer',
  'transcript',
  'utils',
];
const REACHES_A_HOST = [
  /\bvi\.(?:do)?[mM]ock\s*\(/,
  // A DOM is a host too: lit-html captures `document` when its module first
  // evaluates, so the second suite to bring its own jsdom window renders into
  // the first suite's dead document (`d.createComment is not a function`).
  /from\s+['"](?:lit|lit-html|lit\/|@lit\/|jsdom)/,
  /@vitest-environment\s+jsdom|new JSDOM\s*\(/,
  /from\s+['"]@platform\//,
  /from\s+['"]@test\/support\/(?:setupPlatform|setupFakePlatform|FakePlatform|FakeHosts|tempDirPlatform|sessionTestUtils|defaultSessionTestSetup|sessionGraphTestSetup)['"]/,
  /import\s+['"]@test\/support\/(?:defaultSessionTestSetup|sessionGraphTestSetup)['"]/,
];
// What the scan cannot see: a module under test that reads the host itself,
// or a pair of suites sharing process terminal state. Those are found by
// running each suite alone with no host (a deterministic fail) and by file-
// order shuffles, and kept by name in the ratchet baseline — shrink-only, a
// stale entry fails config load.
const KERNEL_BASELINE = 'config/ratchets/pure-tier-kernel-suites.json';
const kernelBaseline = JSON.parse(
  readFileSync(resolve(rootDir, KERNEL_BASELINE), 'utf8'),
);
const keptInKernel = new Set([
  ...kernelBaseline.hostReadByModuleUnderTest,
  ...kernelBaseline.shareTerminalState,
]);
const stale = [...keptInKernel].filter(
  (file) => !existsSync(resolve(rootDir, file)),
);
if (stale.length > 0) {
  throw new Error(
    `${KERNEL_BASELINE} lists suites that no longer exist — remove them:\n  ${stale.join('\n  ')}`,
  );
}
// Resolved to a file list rather than left as globs: Vitest applies a
// project's `exclude` after its `include`, so `kernel` must exclude exactly
// the files `pure` runs, not the directories they came from.
const pureSuites = globSync(
  PURE_DIRS.map((dir) => `src/test-kernel/${dir}/**/*.vitest.ts`),
  { cwd: rootDir, posix: true },
)
  .filter((file) => {
    if (keptInKernel.has(file)) return false;
    const source = readFileSync(resolve(rootDir, file), 'utf8');
    return !REACHES_A_HOST.some((pattern) => pattern.test(source));
  })
  .sort();

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
    passWithNoTests: false,
    testTimeout: kernelTimeoutMs,
    hookTimeout: kernelTimeoutMs,
    projects: [
      {
        extends: true,
        test: {
          name: 'pure',
          isolate: false,
          include: pureSuites,
        },
      },
      {
        extends: true,
        test: {
          name: 'kernel',
          isolate: true,
          include: ['src/test-kernel/**/*.vitest.ts'],
          exclude: pureSuites,
          setupFiles: ['src/test-kernel/support/setupFakePlatform.ts'],
        },
      },
    ],
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
