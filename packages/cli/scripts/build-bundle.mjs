#!/usr/bin/env node

import console from 'node:console';
import process from 'node:process';
import { chmod, readFile, writeFile } from 'node:fs/promises';

import { fileURLToPath, URL } from 'node:url';

const reactDevtoolsStub = fileURLToPath(
  new URL('./react-devtools-core-stub.mjs', import.meta.url),
);

// `--harness` bundles the PTY validator's TUI harness (scripts/tui-harness.tsx)
// through this same build graph, so validate-tui exercises the configuration
// that ships. It stays unminified for readable failure traces.
const harness = process.argv.includes('--harness');
// `--serve` bundles the headless background service (`texra serve` with no
// chat TUI), the file the VS Code extension and the desktop app ship.
const serve = process.argv.includes('--serve');
// `--host-harness` bundles the validator's editor-less window
// (scripts/service-host-harness.ts), which attaches to the service.
const hostHarness = process.argv.includes('--host-harness');
// `--sdk-harness` bundles the validator's SDK embedder
// (scripts/sdk-harness.ts), which runs an inline persona.
const sdkHarness = process.argv.includes('--sdk-harness');
const configuredOutfile = process.env.TEXRA_CLI_BUNDLE_OUTFILE?.trim();
const entryPoint = harness
  ? 'scripts/tui-harness.tsx'
  : hostHarness
    ? 'scripts/service-host-harness.ts'
    : sdkHarness
      ? 'scripts/sdk-harness.ts'
      : serve
        ? 'src/bin/texraServe.ts'
        : 'src/bin/texra.ts';
const outfile = harness
  ? 'dist/bin/tui-harness.js'
  : hostHarness
    ? configuredOutfile || 'dist/bin/service-host-harness.js'
    : sdkHarness
      ? configuredOutfile || 'dist/bin/sdk-harness.js'
      : configuredOutfile ||
        (serve ? 'dist/bin/texra-serve.js' : 'dist/bin/texra.js');
/** The `texra` command the package's `bin` names (see the build's end). */
const LAUNCHER = 'dist/texra.js';
const includeInternalValidationModel =
  process.env.TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL === '1';

try {
  const [
    { build },
    { reactCompilerPlugin },
    { esmCjsGlobalsBanner },
    { stubInternalValidationModel },
    { harnessBundleOptions },
    { default: semver },
  ] = await Promise.all([
    import('esbuild'),
    import('./reactCompilerPlugin.mjs'),
    import('../../../scripts/esm-cjs-globals-banner.mjs'),
    import('../../../scripts/stub-internal-validation-model.mjs'),
    import('../../../scripts/code-sandbox-worker.mjs'),
    import('semver'),
  ]);

  const { engines } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const base = harnessBundleOptions();
  await build({
    ...base,
    entryPoints: [entryPoint],
    platform: 'node',
    format: 'esm',
    // The lowest Node the package's `engines` admits.
    target: `node${semver.minVersion(engines.node).version}`,
    external: ['fsevents'],
    alias: {
      // Ink statically imports `react-devtools-core` from its `devtools.js`,
      // which is only reached when `process.env.DEV === 'true'`. We never
      // attach to React DevTools from the production CLI, so alias the import
      // to a no-op stub. Avoids pulling the (heavy) real package into the
      // bundle while keeping ink's dynamic-import path resolvable.
      'react-devtools-core': reactDevtoolsStub,
    },
    outfile,
    minify: !harness,
    sourcemap: false,
    legalComments: 'none',
    // The React Compiler runs as a Babel pre-pass scoped to .tsx files under
    // packages/cli/src/chat/tui/ and packages/cli/src/tui/ (the shared Ink UI
    // kit). Confirmed addition is only `react/compiler-runtime`; see
    // 2026-05-14-20-implementation.md (Phase 0). Risk R12.
    plugins: [
      reactCompilerPlugin(),
      ...base.plugins,
      ...(includeInternalValidationModel ? [] : [stubInternalValidationModel]),
    ],
    // JSX needs to be transformed for ink (which uses React's JSX runtime).
    jsx: 'automatic',
    banner: {
      js: `#!/usr/bin/env node\n${esmCjsGlobalsBanner}`,
    },
  });

  await chmod(outfile, 0o755);
  if (outfile === 'dist/bin/texra.js') {
    // The published command: a few lines that drop node:sqlite's warning and
    // turn on Node's on-disk compile cache before the bundle loads, so a start after the first skips most of
    // compiling it (about 230 ms of each start). The cache lives under the
    // user's own ~/.texra, not Node's default shared temp directory, where
    // another user could plant code for this process to load. The bundle
    // stays at dist/bin/texra.js, so every path it resolves beside itself
    // still holds.
    await writeFile(
      LAUNCHER,
      [
        '#!/usr/bin/env node',
        "import module from 'node:module';",
        "import { homedir } from 'node:os';",
        "import { join } from 'node:path';",
        '// node:sqlite, which the session store is built on, prints an',
        '// ExperimentalWarning on every start in the Node versions TeXRA',
        '// supports. The bundle imports it statically, so only code here runs',
        '// early enough to drop that one warning; every other warning prints.',
        'const emitWarning = process.emitWarning;',
        'process.emitWarning = (warning, ...rest) => {',
        "  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;",
        "  if (type === 'ExperimentalWarning' && String(warning).startsWith('SQLite')) return;",
        '  emitWarning.call(process, warning, ...rest);',
        '};',
        '// The cache is an optimization: no home directory (HOME unset, where',
        '// os.homedir() throws) or a refused cache never stops the CLI starting.',
        'try {',
        "  module.enableCompileCache?.(join(homedir(), '.texra', 'compile-cache'));",
        '} catch {}',
        "await import('./bin/texra.js');",
        '',
      ].join('\n'),
    );
    await chmod(LAUNCHER, 0o755);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[build-bundle] failed to build ${outfile}.`);
  console.error(
    '[build-bundle] If dependencies are missing, run `corepack pnpm install` from the repo root.',
  );
  console.error(`[build-bundle] ${message}`);
  process.exit(1);
}
