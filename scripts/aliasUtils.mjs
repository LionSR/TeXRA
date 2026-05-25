/**
 * Utilities for deriving build-tool aliases from a package tsconfig.
 *
 * Note: callers (esbuild + Vite configs) pass the *root* repo dir, so the
 * single source of truth for build-time aliases is the root `tsconfig.json`.
 * `packages/extension/tsconfig.json` is only consulted by `tsc` for typecheck;
 * if the two diverge, builds will silently follow the root.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'path';

export function loadAliases(rootDir) {
  const tsconfig = readTsconfig(resolve(rootDir, 'tsconfig.json'));

  return Object.fromEntries(
    Object.entries(tsconfig.compilerOptions.paths)
      .filter(([, values]) => !values[0].endsWith('.d.ts'))
      .map(([key, values]) => {
        const aliasKey = key.replace('/*', '');
        const pathValue = values[0].replace('/*', '');

        return [aliasKey, resolve(rootDir, pathValue)];
      }),
  );
}

export function loadAliasEntries(rootDir) {
  const tsconfig = readTsconfig(resolve(rootDir, 'tsconfig.json'));

  return Object.entries(tsconfig.compilerOptions.paths).flatMap(
    ([key, values]) => {
      const alias = key.replace('/*', '');
      const requiresSubpath = key.endsWith('/*');

      return values
        .filter((pathValue) => !pathValue.endsWith('.d.ts'))
        .map((pathValue) => ({
          alias,
          requiresSubpath,
          absolutePath: resolve(rootDir, pathValue.replace('/*', '')),
        }));
    },
  );
}

function readTsconfig(tsconfigPath) {
  const tsconfigText = readFileSync(tsconfigPath, 'utf8');
  return JSON.parse(stripJsonComments(tsconfigText));
}

function stripJsonComments(text) {
  let result = '';
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && (i === 0 || text[i - 1] !== '\\')) {
      inString = !inString;
      result += char;
      i++;
      continue;
    }

    if (!inString) {
      if (char === '/' && next === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }

      if (char === '/' && next === '*') {
        i += 2;
        while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/'))
          i++;
        i += 2;
        continue;
      }
    }

    result += char;
    i++;
  }

  return result.replace(/,(\s*[}\]])/g, '$1');
}
