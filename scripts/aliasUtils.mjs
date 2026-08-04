/**
 * Utilities for deriving build-tool aliases from a package tsconfig.
 *
 * Vite callers pass the *root* repo dir, so `loadAliases` reads the root
 * `tsconfig.json` directly. Extension esbuild instead reads its generated
 * package tsconfig; `sync-tsconfig-paths.mjs` keeps that map aligned with the
 * root source of truth and its check mode rejects drift.
 */

import { existsSync, readFileSync } from 'node:fs';
import { globSync } from 'glob';
import { resolve } from 'node:path';
import ts from 'typescript';

export function loadAliases(rootDir) {
  const tsconfig = readTsconfig(resolve(rootDir, 'tsconfig.json'));

  return Object.fromEntries(
    Object.entries(tsconfig.compilerOptions.paths)
      .filter(([, values]) => !values[0].endsWith('.d.ts'))
      .map(([key, values]) => {
        const aliasKey = key.replace('/*', '');
        // Prefer the bare '*' variant (ends with just '/*') — it strips
        // cleanly to a directory path for build tools.  Fall back to the
        // first value when there is no bare variant (e.g. non-wildcard
        // aliases like "@transcript" which map to an index.ts file).
        const best = values.find((v) => v.endsWith('/*')) ?? values[0];
        const pathValue = best.replace('/*', '');

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
 * map. Neither tsconfig sets `baseUrl`, so values resolve relative to the
 * file that declares them: root values under `packages/extension/` become
 * `./`-prefixed extension-relative values, and every other
 * (repo-root-relative) value gets a `./../../` prefix.
 */
export function deriveExtensionPaths(rootPaths) {
  return Object.fromEntries(
    Object.entries(rootPaths)
      .filter(([key]) => !EXTENSION_EXCLUDED_ALIASES.includes(key))
      .map(([key, values]) => [
        key,
        values.map((value) => {
          const repoRelative = value.replace(/^\.\//u, '');
          return repoRelative.startsWith(EXTENSION_PREFIX)
            ? `./${repoRelative.slice(EXTENSION_PREFIX.length)}`
            : `./../../${repoRelative}`;
        }),
      ]),
  );
}

/**
 * Derives `packages/desktop/tsconfig.paths.json`'s `paths` block from the
 * root map. With no `baseUrl`, desktop's values resolve relative to
 * `packages/desktop/`, so every root value gets a `./../../` prefix to stay
 * repo-root-relative. No exclusions.
 */
export function deriveDesktopPaths(rootPaths) {
  return Object.fromEntries(
    Object.entries(rootPaths).map(([key, values]) => [
      key,
      values.map((value) => `./../../${value.replace(/^\.\//u, '')}`),
    ]),
  );
}

// Aliases that the declaration-only agent build cannot resolve because its
// include is intentionally limited to packages/agent/src and root src/types.
export const BUILD_EXCLUDED_ALIASES = [
  'vscode-jsonrpc/node',
  '@common/state',
  '@common/state/*',
  '@common/webview',
  '@common/webview/*',
  '@webview/*',
  '@frontend/*',
  '@commands/*',
  '@resources/*',
  '@progressView/*',
  '@settingsView/*',
  '@extensionSchemas/*',
  'turndown-plugin-gfm',
  'data-uri-to-buffer',
  '@openrouter/sdk',
  '@openrouter/sdk/models',
  '@openrouter/sdk/models/errors',
  '@controllers/*',
  '@test/*',
  '@cli/*',
  '@desktop/*',
];

/** Derives the declaration-only agent build map from the root aliases. */
export function deriveBuildPaths(rootPaths) {
  return Object.fromEntries(
    Object.entries(rootPaths).filter(
      ([key]) => !BUILD_EXCLUDED_ALIASES.includes(key),
    ),
  );
}

export function loadAliasEntries(rootDir) {
  const tsconfig = readTsconfig(resolve(rootDir, 'tsconfig.json'));

  return Object.entries(tsconfig.compilerOptions.paths ?? {}).flatMap(
    ([key, values]) => {
      const alias = key.replace('/*', '');
      const requiresSubpath = key.endsWith('/*');

      return values
        .filter(
          (pathValue) =>
            !pathValue.endsWith('.d.ts') &&
            // Only use the bare '*' variant for build aliases — the *.ts
            // and */index.ts variants are for tsc nodenext resolution only.
            pathValue.endsWith('/*'),
        )
        .map((pathValue) => ({
          alias,
          requiresSubpath,
          absolutePath: resolve(rootDir, pathValue.replace('/*', '')),
        }));
    },
  );
}

function readTsconfig(tsconfigPath) {
  return parseJsonc(readFileSync(tsconfigPath, 'utf8'));
}

export function parseJsonc(text) {
  const { config, error } = ts.parseConfigFileTextToJson('tsconfig.json', text);
  if (error) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  }
  return config;
}

export function pathTargetExists(rootDir, target) {
  return target.includes('*')
    ? globSync(target, { cwd: rootDir, nodir: false }).length > 0
    : existsSync(resolve(rootDir, target));
}
