/**
 * Utilities for deriving build-tool aliases from a package tsconfig.
 *
 * Vite callers pass the *root* repo dir, so `loadAliases` reads the root
 * `tsconfig.json` directly. Extension esbuild instead reads its generated
 * package tsconfig; `sync-tsconfig-paths.mjs` keeps that map aligned with the
 * root source of truth and its check mode rejects drift.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

/**
 * Returns the root tsconfig's raw `compilerOptions.paths` map (unfiltered,
 * multi-value arrays intact) so it can be re-derived for the package tsconfig
 * copies. Unlike `loadAliases`/`loadAliasEntries`, this keeps `.d.ts` entries
 * — package tsconfigs need them for `tsc` module resolution even though the
 * esbuild/Vite build aliases don't.
 */
export function loadRootPaths(rootDir) {
  const tsconfig = readTsconfig(resolve(rootDir, 'tsconfig.json'));
  return tsconfig.compilerOptions.paths;
}

// Aliases the root tsconfig defines that `packages/extension/tsconfig.json`
// deliberately omits: each is only ever imported from repo-root `src/`
// locations the extension's own tsconfig doesn't include (its `include` is
// scoped to `packages/extension/src`), so adding them would widen what the
// extension can *type-check* against without widening what it can actually
// import at runtime. Verified by grepping for each alias's usage (2026-07):
// `vscode-jsonrpc/node` and the rest below resolve only inside
// `src/tools/lean/direct/jsonRpc.ts` and `src/test-kernel/**`.
export const EXTENSION_EXCLUDED_ALIASES = [
  'vscode-jsonrpc/node',
  '@extensionSchemas/*',
  '@test/*',
  '@cli/*',
  '@desktop/*',
];

const EXTENSION_PREFIX = 'packages/extension/';

/**
 * Derives `packages/extension/tsconfig.json`'s `paths` block from the root
 * map. The extension's `baseUrl` is `packages/extension`, so root path
 * values under `packages/extension/` become extension-relative, and every
 * other (repo-root-relative) value gets `../../` prepended.
 */
export function deriveExtensionPaths(rootPaths) {
  return Object.fromEntries(
    Object.entries(rootPaths)
      .filter(([key]) => !EXTENSION_EXCLUDED_ALIASES.includes(key))
      .map(([key, values]) => [
        key,
        values.map((value) =>
          value.startsWith(EXTENSION_PREFIX)
            ? value.slice(EXTENSION_PREFIX.length)
            : `../../${value}`,
        ),
      ]),
  );
}

/**
 * Derives `packages/desktop/tsconfig.paths.json`'s `paths` block from the
 * root map. Desktop's `baseUrl` is already `../..` (the repo root), so its
 * path values are identical to the root tsconfig's — no rewriting, no
 * exclusions.
 */
export function deriveDesktopPaths(rootPaths) {
  return { ...rootPaths };
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
