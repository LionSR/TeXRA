#!/usr/bin/env node

import console from 'node:console';
import process from 'node:process';
import { chmod } from 'node:fs/promises';

import { fileURLToPath, URL } from 'node:url';

const reactDevtoolsStub = fileURLToPath(
  new URL('./react-devtools-core-stub.mjs', import.meta.url),
);
const internalValidationModelStub = fileURLToPath(
  new URL('./internal-validation-model-stub.mjs', import.meta.url),
);

// `--harness` bundles the PTY validator's TUI harness (scripts/tui-harness.tsx)
// through this same build graph, so validate-tui exercises the configuration
// that ships. It stays unminified for readable failure traces.
const harness = process.argv.includes('--harness');
const configuredOutfile = process.env.TEXRA_CLI_BUNDLE_OUTFILE?.trim();
const entryPoint = harness ? 'scripts/tui-harness.tsx' : 'src/bin/texra.ts';
const outfile = harness
  ? 'dist/bin/tui-harness.js'
  : configuredOutfile || 'dist/bin/texra.js';
const includeInternalValidationModel =
  process.env.TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL === '1';

try {
  const [{ build }, { reactCompilerPlugin }, { esmCjsGlobalsBanner }] =
    await Promise.all([
      import('esbuild'),
      import('./reactCompilerPlugin.mjs'),
      import('../../../scripts/esm-cjs-globals-banner.mjs'),
    ]);

  await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['fsevents'],
    loader: { '.wasm': 'binary' },
    define: {
      'process.env.TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL': JSON.stringify(
        includeInternalValidationModel ? '1' : '',
      ),
      'process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_ENV': JSON.stringify(
        includeInternalValidationModel ? 'TEXRA_INTERNAL_VALIDATE_MODEL' : '',
      ),
      'process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_FLAG_ENV':
        JSON.stringify(
          includeInternalValidationModel
            ? 'TEXRA_INTERNAL_VALIDATE_MODEL_FLAG'
            : '',
        ),
      'process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_FLAG_CONTENT':
        JSON.stringify(
          includeInternalValidationModel ? 'texra-cli-run-validation' : '',
        ),
    },
    alias: {
      // Ink statically imports `react-devtools-core` from its `devtools.js`,
      // which is only reached when `process.env.DEV === 'true'`. We never
      // attach to React DevTools from the production CLI, so alias the import
      // to a no-op stub. Avoids pulling the (heavy) real package into the
      // bundle while keeping ink's dynamic-import path resolvable.
      'react-devtools-core': reactDevtoolsStub,
      ...(!includeInternalValidationModel
        ? {
            '@agent/runtime/run/validationModel': internalValidationModelStub,
          }
        : {}),
    },
    outfile,
    minify: !harness,
    // SDK error classification (src/common/errors/sdkError/) reads
    // `constructor.name` off the prototype chain, so minified class names
    // would silently misclassify provider errors in the published binary.
    keepNames: true,
    sourcemap: false,
    legalComments: 'none',
    // The React Compiler runs as a Babel pre-pass scoped to .tsx files under
    // packages/cli/src/chat/tui/ and packages/cli/src/tui/ (the shared Ink UI
    // kit). Confirmed addition is only `react/compiler-runtime`; see
    // .agents/docs/archived/feature/2026-05-14-cli-tui-ink/2026-05-14-20-implementation.md (Phase 0). Risk R12.
    plugins: [reactCompilerPlugin()],
    // JSX needs to be transformed for ink (which uses React's JSX runtime).
    jsx: 'automatic',
    banner: {
      js: `#!/usr/bin/env node\n${esmCjsGlobalsBanner}`,
    },
  });

  await chmod(outfile, 0o755);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[build-bundle] failed to build ${outfile}.`);
  console.error(
    '[build-bundle] If dependencies are missing, run `corepack pnpm install` from the repo root.',
  );
  console.error(`[build-bundle] ${message}`);
  process.exit(1);
}
