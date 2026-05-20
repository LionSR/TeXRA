#!/usr/bin/env node

import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { reactCompilerPlugin } from './reactCompilerPlugin.mjs';

const reactDevtoolsStub = fileURLToPath(
  new URL('./react-devtools-core-stub.mjs', import.meta.url),
);
const internalValidationModelStub = fileURLToPath(
  new URL('./internal-validation-model-stub.mjs', import.meta.url),
);

const outfile = 'dist/bin/texra.js';
const includeInternalValidationModel =
  process.env.TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL === '1';

await build({
  entryPoints: ['src/bin/texra.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['fsevents'],
  define: {
    'process.env.TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL': JSON.stringify(
      includeInternalValidationModel ? '1' : '',
    ),
    'process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_HANDLER_ENV':
      JSON.stringify(
        includeInternalValidationModel
          ? 'TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER'
          : '',
      ),
    'process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_HANDLER_FLAG_ENV':
      JSON.stringify(
        includeInternalValidationModel
          ? 'TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER_FLAG'
          : '',
      ),
    'process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_HANDLER_FLAG_CONTENT':
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
          '@agent/modelHandlers/modelHandlerValidation':
            internalValidationModelStub,
        }
      : {}),
  },
  outfile,
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  // The React Compiler runs as a Babel pre-pass scoped to .tsx files under
  // packages/cli/src/chat/tui/. Confirmed addition is only
  // `react/compiler-runtime`; see docs/prd/cli-tui-ink/20-implementation.md
  // (Phase 0). Risk R12.
  plugins: [reactCompilerPlugin()],
  // JSX needs to be transformed for ink (which uses React's JSX runtime).
  jsx: 'automatic',
  banner: {
    js:
      '#!/usr/bin/env node\n' +
      'import { createRequire as __texraCreateRequire } from "node:module";\n' +
      'const require = __texraCreateRequire(import.meta.url);',
  },
});

await chmod(outfile, 0o755);
