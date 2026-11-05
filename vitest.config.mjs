import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';

import { globSync } from 'glob';
import { defineConfig } from 'vitest/config';

import { aliases, rootDir } from './scripts/aliases.mjs';
import {
  bundleCodeSandboxWorker,
  CODE_SANDBOX_WORKER_ID,
} from './scripts/code-sandbox-worker.mjs';

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
// A suite's cost is its import closure evaluated once per file, so every
// suite a module registry shared between files can serve gets one: the fake
// platform, the session runtime and everything behind them are evaluated once
// per worker, not once per file. Three projects:
//
// - `pure`: suites of host-free modules. No setup file, and nothing in them
//   installs or replaces anything, so nothing can leak. Measured on 136
//   suites: 28s against 1m55s isolated.
// - `kernel`: the other suites a shared registry can serve. Each states the
//   host it runs over as a layer its blocks build, and a block's scope
//   releases what it built (`support/testKernel.ts`), so nothing a file
//   installs outlives it.
// - `isolated`: what a shared registry cannot serve, each file in its own
//   registry and its own worker.
//
// Membership is computed from the suite's source, not declared. A suite is
// `isolated` when it needs its own registry (`NEEDS_OWN_REGISTRY`,
// `DOM_DIRS`): add a `vi.mock` and it moves there on its own, remove it and
// the suite moves back. Otherwise a suite under one of these directories is
// `pure` unless it reaches a host (`@platform/*`, or the support modules that
// install or read one), and every other suite is `kernel`. A directory earns
// a place in this list by holding suites of host-free modules; the scan
// decides file by file.
const PURE_DIRS = [
  'agent',
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
  /from\s+['"]@platform\//,
  /from\s+['"]@test\/support\/(?:setupPlatform|FakePlatform|texraApp|FakeHosts|tempDirPlatform|nativeToolTestLayer|sessionTestUtils|crashConformance|testWorkspaceRoots|testKernel|logSinkCapture)['"]/,
];
// What a shared registry cannot serve: a `vi.mock` / `vi.doMock` factory (the
// module it built stays in the registry, and a partial factory is what the
// next suite imports); `vi.resetModules` (it empties the registry the next
// suite would reuse); and a DOM (lit-html captures `document` when its module
// first evaluates, so the second suite to bring its own jsdom window renders
// into the first suite's dead document: `d.createComment is not a function`).
const NEEDS_OWN_REGISTRY = [
  /\bvi\.(?:do)?[mM]ock\s*\(/,
  /\bvi\.resetModules\s*\(/,
  /from\s+['"](?:lit|lit-html|lit\/|@lit\/|jsdom)/,
  /@vitest-environment\s+jsdom|new JSDOM\s*\(/,
];
// The DOM directories: their suites bring a window or load modules afresh
// through helpers a scan of the suite does not see
// (`settings/litComponentTestUtils.ts`, `desktop/loadSourceModule.ts`), so
// the directory decides for every suite in it.
const DOM_DIRS = ['desktop', 'progressView', 'settings'];
// What the scan cannot see is a suite that changes process-wide state: an
// environment variable a library reads once (chalk's color level), a file
// left in the worker's home or fake root. A shared worker runs file after
// file, so file-order shuffles find those, and the fix is in the suite: set
// the state on the instance it lives on and restore it after, so the order a
// worker runs files in cannot matter.
//
// Resolved to file lists rather than left as globs: Vitest applies a
// project's `exclude` after its `include`, so `isolated` must exclude exactly
// the files the other two run, not the directories they came from.
const sharedSuites = { pure: [], kernel: [] };
// A suite lives with the package it tests (packages/<name>/test/) or, when it
// composes several packages, in src/test-kernel/; either way its tier
// directory is the first one under that test root.
const SUITES = [
  'src/test-kernel/**/*.vitest.ts',
  'packages/*/test/**/*.vitest.ts',
];
for (const file of globSync(SUITES, { cwd: rootDir, posix: true }).sort()) {
  const parts = file.split('/');
  const dir = parts[0] === 'packages' ? parts[3] : parts[2];
  const source = readFileSync(resolve(rootDir, file), 'utf8');
  if (DOM_DIRS.includes(dir) || NEEDS_OWN_REGISTRY.some((p) => p.test(source)))
    continue;
  const reachesAHost =
    !PURE_DIRS.includes(dir) || REACHES_A_HOST.some((p) => p.test(source));
  sharedSuites[reachesAHost ? 'kernel' : 'pure'].push(file);
}
// The temp home first, then the check that nothing still reaches the real
// one: setup files run in order, so no module of the repository loads before
// the real home is gone. They run before every file; a worker swaps its home
// once, for its first file, and keeps it for every file it runs after.
const HOME_SETUP_FILES = [
  'src/test-kernel/support/isolateHome.ts',
  'src/test-kernel/support/homeIsolationCheck.ts',
];

export default defineConfig({
  plugins: [
    texTemplatePlugin(),
    quickJsWasmPlugin(),
    codeSandboxWorkerPlugin(),
  ],
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
    testTimeout: kernelTimeoutMs,
    hookTimeout: kernelTimeoutMs,
    // One temp folder per run, which every worker's temp files go under and
    // the run's teardown removes: a worker the pool ends never cleans up.
    globalSetup: ['src/test-kernel/support/testTempRoot.ts'],
    // A local run shares the machine with the editor and with a second run
    // (another worktree, a watcher), so it takes half the cores: two runs fill
    // the machine and no more. CI owns its runner and keeps Vitest's default.
    // `VITEST_MAX_WORKERS` overrides both.
    maxWorkers: process.env.CI ? undefined : '50%',
    // The Node child-process spawner is the library's, so the suite that
    // hands it an in-memory child mocks `node:child_process` underneath it.
    // A dependency Vitest externalises imports Node builtins natively and
    // never sees that mock, so these two are processed by the module runner.
    server: {
      deps: {
        inline: ['@effect/platform-node', '@effect/platform-node-shared'],
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'pure',
          isolate: false,
          include: sharedSuites.pure,
        },
      },
      {
        extends: true,
        test: {
          name: 'kernel',
          isolate: false,
          include: sharedSuites.kernel,
          setupFiles: HOME_SETUP_FILES,
        },
      },
      {
        extends: true,
        test: {
          name: 'isolated',
          isolate: true,
          // Every suite the other two do not run, so one the scan has not
          // seen yet (a file added while a watcher runs) runs isolated.
          include: SUITES,
          exclude: [...sharedSuites.pure, ...sharedSuites.kernel],
          setupFiles: HOME_SETUP_FILES,
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

/**
 * Serves the worker the way every host bundle embeds it, so a suite starts
 * the same bundled worker the hosts ship rather than a TypeScript entry Node
 * cannot load.
 */
function codeSandboxWorkerPlugin() {
  const virtualId = `\0${CODE_SANDBOX_WORKER_ID}`;
  return {
    name: 'code-sandbox-worker',
    enforce: 'pre',
    resolveId(source) {
      return source === CODE_SANDBOX_WORKER_ID ? virtualId : undefined;
    },
    async load(id) {
      if (id !== virtualId) return undefined;
      const { source } = await bundleCodeSandboxWorker();
      return { code: `export default ${JSON.stringify(source)};`, map: null };
    },
  };
}
