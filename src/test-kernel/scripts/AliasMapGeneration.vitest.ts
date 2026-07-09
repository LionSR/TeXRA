import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

type TsconfigPaths = Record<string, string[]>;

interface AliasUtilsModule {
  deriveDesktopPaths(rootPaths: TsconfigPaths): TsconfigPaths;
  deriveExtensionPaths(rootPaths: TsconfigPaths): TsconfigPaths;
  EXTENSION_EXCLUDED_ALIASES: readonly string[];
  loadRootPaths(rootDir: string): TsconfigPaths;
}

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
const {
  deriveDesktopPaths,
  deriveExtensionPaths,
  EXTENSION_EXCLUDED_ALIASES,
  loadRootPaths,
} = (await import(
  pathToFileURL(resolve(rootDir, 'scripts/aliasUtils.mjs')).href
)) as AliasUtilsModule;

const SAMPLE_ROOT_PATHS = {
  'vscode-jsonrpc/node': ['node_modules/vscode-jsonrpc/lib/node/main'],
  '@/*': ['packages/extension/src/*', 'src/*'],
  '@shared/*': ['src/shared/*'],
  '@commands/*': ['packages/extension/src/commands/*'],
  '@extensionSchemas/*': ['packages/extension/src/schemas/*'],
  '@test/*': ['src/test-kernel/*'],
  '@cli/*': ['packages/cli/src/*'],
  '@desktop/*': ['packages/desktop/src/*'],
};

describe('aliasUtils deriveExtensionPaths', () => {
  it('rewrites packages/extension/-prefixed values as extension-relative', () => {
    const result = deriveExtensionPaths(SAMPLE_ROOT_PATHS);

    expect(result['@commands/*']).toEqual(['src/commands/*']);
  });

  it('prepends ../../ to repo-root-relative values', () => {
    const result = deriveExtensionPaths(SAMPLE_ROOT_PATHS);

    expect(result['@shared/*']).toEqual(['../../src/shared/*']);
  });

  it('rewrites each entry of a multi-value alias independently', () => {
    const result = deriveExtensionPaths(SAMPLE_ROOT_PATHS);

    expect(result['@/*']).toEqual(['src/*', '../../src/*']);
  });

  it('drops every deliberately excluded alias and keeps everything else', () => {
    const result = deriveExtensionPaths(SAMPLE_ROOT_PATHS);

    for (const excluded of EXTENSION_EXCLUDED_ALIASES) {
      expect(result).not.toHaveProperty(excluded);
    }
    expect(Object.keys(result)).toEqual(['@/*', '@shared/*', '@commands/*']);
  });
});

describe('aliasUtils deriveDesktopPaths', () => {
  it('returns the root paths unchanged (desktop baseUrl is already the repo root)', () => {
    expect(deriveDesktopPaths(SAMPLE_ROOT_PATHS)).toEqual(SAMPLE_ROOT_PATHS);
  });

  it('excludes nothing, unlike deriveExtensionPaths', () => {
    const result = deriveDesktopPaths(SAMPLE_ROOT_PATHS);

    for (const excluded of EXTENSION_EXCLUDED_ALIASES) {
      expect(result).toHaveProperty(excluded);
    }
  });
});

describe('generated tsconfig paths match the committed copies', () => {
  // Regression guard for the generator itself: fails if a copy is hand-edited
  // without regenerating (the CI-facing version of this is
  // `npm run check:tsconfig-paths`; this test gives the same signal in the
  // normal `npm test` loop).
  const rootPaths = loadRootPaths(rootDir);

  it('packages/extension/tsconfig.json paths derive from the root map', () => {
    const committed = JSON.parse(
      readFileSync(
        resolve(rootDir, 'packages/extension/tsconfig.json'),
        'utf8',
      ),
    );

    expect(committed.compilerOptions.paths).toEqual(
      deriveExtensionPaths(rootPaths),
    );
  });

  it('packages/desktop/tsconfig.paths.json paths derive from the root map', () => {
    const committed = JSON.parse(
      readFileSync(
        resolve(rootDir, 'packages/desktop/tsconfig.paths.json'),
        'utf8',
      ),
    );

    expect(committed.compilerOptions.paths).toEqual(
      deriveDesktopPaths(rootPaths),
    );
  });
});
