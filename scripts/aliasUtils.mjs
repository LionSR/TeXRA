/**
 * Derives build-tool aliases from the root `tsconfig.json`, the single source
 * of truth for path aliases. Every package tsconfig extends the root and
 * inherits its `paths`; Vite and Vitest read the map through here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

export function loadAliases(rootDir) {
  const tsconfig = readTsconfig(resolve(rootDir, 'tsconfig.json'));

  return Object.fromEntries(
    Object.entries(tsconfig.compilerOptions.paths).map(([key, values]) => {
      const aliasKey = key.replace('/*', '');
      // Prefer the bare '*' variant (ends with just '/*') — it strips
      // cleanly to a directory path for build tools.  Fall back to the
      // first value when there is no bare variant (e.g. non-wildcard
      // aliases like "@texra-ai/harness" which map to a single file).
      const best = values.find((v) => v.endsWith('/*')) ?? values[0];
      const pathValue = best.replace('/*', '');

      return [aliasKey, resolve(rootDir, pathValue)];
    }),
  );
}

function readTsconfig(tsconfigPath) {
  const { config, error } = ts.parseConfigFileTextToJson(
    tsconfigPath,
    readFileSync(tsconfigPath, 'utf8'),
  );
  if (error) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  }
  return config;
}
