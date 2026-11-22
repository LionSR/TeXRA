/**
 * Shared path aliases derived from tsconfig.json for the Vite, Vitest and
 * oxlint configs, and the shared `dedupe` list for Vite build configs.
 * Extension esbuild reads its package tsconfig, which extends the root.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const rootDir = resolve(import.meta.dirname, '..');

/**
 * The root tsconfig's paths as build tool aliases. Every package tsconfig
 * extends the root and inherits its `paths`.
 *
 * tsconfig format: { "@alias/*": ["src/path/*"] }
 * output format:   { "@alias": "/absolute/path/to/src/path" }
 */
function loadAliases() {
  const tsconfigPath = resolve(rootDir, 'tsconfig.json');
  const { config: tsconfig, error } = ts.parseConfigFileTextToJson(
    tsconfigPath,
    readFileSync(tsconfigPath, 'utf8'),
  );
  if (error) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  }

  return Object.fromEntries(
    Object.entries(tsconfig.compilerOptions.paths).map(([key, values]) => {
      const aliasKey = key.replace('/*', '');
      // Prefer the bare '*' variant (ends with just '/*') — it strips
      // cleanly to a directory path for build tools.  Fall back to the
      // first value when there is no bare variant (e.g. non-wildcard
      // aliases like "@texra-ai/worldline" which map to a single file).
      const best = values.find((v) => v.endsWith('/*')) ?? values[0];
      const pathValue = best.replace('/*', '');

      return [aliasKey, resolve(rootDir, pathValue)];
    }),
  );
}

export const aliases = Object.freeze(loadAliases());

/**
 * Packages a Vite build resolves from the project root, so the sources it
 * pulls in from several workspace packages share one copy: Web Awesome and
 * Lit define their custom elements once, and the signals share one graph.
 */
export const dedupe = Object.freeze([
  '@awesome.me/webawesome',
  '@lit-labs/signals',
  'lit',
  'signal-polyfill',
]);

/**
 * Root directory of the project.
 */
export { rootDir };
