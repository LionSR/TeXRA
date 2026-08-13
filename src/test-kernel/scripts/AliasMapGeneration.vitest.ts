import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

type TsconfigPaths = Record<string, string[]>;

interface AliasUtilsModule {
  deriveBuildPaths(rootPaths: TsconfigPaths): TsconfigPaths;
  deriveDesktopPaths(rootPaths: TsconfigPaths): TsconfigPaths;
  deriveExtensionPaths(rootPaths: TsconfigPaths): TsconfigPaths;
  EXTENSION_EXCLUDED_ALIASES: readonly string[];
  loadRootPaths(rootDir: string): TsconfigPaths;
  parseJsonc(text: string): unknown;
  pathTargetExists(rootDir: string, target: string): boolean;
}

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
const {
  deriveBuildPaths,
  deriveDesktopPaths,
  deriveExtensionPaths,
  EXTENSION_EXCLUDED_ALIASES,
  loadRootPaths,
  parseJsonc,
  pathTargetExists,
} = (await import(
  pathToFileURL(resolve(rootDir, 'scripts/aliasUtils.mjs')).href
)) as AliasUtilsModule;

const SAMPLE_ROOT_PATHS = {
  'vscode-jsonrpc/node': ['./node_modules/vscode-jsonrpc/lib/node/main'],
  '@/*': ['./packages/extension/src/*', './src/*'],
  '@shared/*': ['./src/shared/*'],
  '@commands/*': ['./packages/extension/src/commands/*'],
  '@extensionSchemas/*': ['./packages/extension/src/schemas/*'],
  '@test/*': ['./src/test-kernel/*'],
  '@cli/*': ['./packages/cli/src/*'],
  '@desktop/*': ['./packages/desktop/src/*'],
};

describe('aliasUtils deriveExtensionPaths', () => {
  const result = deriveExtensionPaths(SAMPLE_ROOT_PATHS);

  it('rewrites packages/extension/-prefixed values as extension-relative', () => {
    expect(result['@commands/*']).toEqual(['./src/commands/*']);
  });

  it('prepends ./../../ to repo-root-relative values', () => {
    expect(result['@shared/*']).toEqual(['./../../src/shared/*']);
  });

  it('rewrites each entry of a multi-value alias independently', () => {
    expect(result['@/*']).toEqual(['./src/*', './../../src/*']);
  });

  it('drops every deliberately excluded alias and keeps everything else', () => {
    for (const excluded of EXTENSION_EXCLUDED_ALIASES) {
      expect(result).not.toHaveProperty(excluded);
    }
    expect(Object.keys(result)).toEqual(['@/*', '@shared/*', '@commands/*']);
  });
});

describe('aliasUtils deriveDesktopPaths', () => {
  const result = deriveDesktopPaths(SAMPLE_ROOT_PATHS);

  it('prefixes every value with ./../../ so it stays repo-root-relative', () => {
    expect(result['@shared/*']).toEqual(['./../../src/shared/*']);
    expect(result['@/*']).toEqual([
      './../../packages/extension/src/*',
      './../../src/*',
    ]);
  });

  it('excludes nothing, unlike deriveExtensionPaths', () => {
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

  interface CommittedTsconfig {
    extends?: string;
    compilerOptions: { paths?: unknown };
  }

  function readCommittedTsconfig(relativePath: string): CommittedTsconfig {
    return JSON.parse(
      readFileSync(resolve(rootDir, relativePath), 'utf8'),
    ) as CommittedTsconfig;
  }

  it('tsconfig.build.json paths derive from the root map', () => {
    const committed = readCommittedTsconfig('tsconfig.build.json');

    expect(committed.compilerOptions.paths).toEqual(
      deriveBuildPaths(rootPaths),
    );
  });

  it('packages/extension/tsconfig.json extends root and inherits its paths', () => {
    const committed = readCommittedTsconfig('packages/extension/tsconfig.json');

    expect(committed.extends).toBe('../../tsconfig.json');
    expect(
      committed.compilerOptions.paths,
      'extension no longer carries its own paths — it inherits from root',
    ).toBeUndefined();
  });

  it('packages/desktop/tsconfig.paths.json paths derive from the root map', () => {
    const committed = readCommittedTsconfig(
      'packages/desktop/tsconfig.paths.json',
    );

    expect(committed.compilerOptions.paths).toEqual(
      deriveDesktopPaths(rootPaths),
    );
  });
});

describe('generated build-map validation helpers', () => {
  it('parses comments and trailing commas without rewriting string contents', () => {
    expect(
      parseJsonc(`{
        // whole-line comment
        "compilerOptions": { /* inline block comment */
          "paths": {
            "@shared/*": ["src/shared/*.ts"], // inline comment
          },
        },
        "literalCommaBrace": ",}",
        "literalCommaBracket": ",]",
        "escapedQuote": "before \\\" after",
      }`),
    ).toEqual({
      compilerOptions: { paths: { '@shared/*': ['src/shared/*.ts'] } },
      literalCommaBrace: ',}',
      literalCommaBracket: ',]',
      escapedQuote: 'before " after',
    });
  });

  it('requires wildcard targets to match at least one file', () => {
    expect(pathTargetExists(rootDir, 'src/shared/*.ts')).toBe(true);
    expect(pathTargetExists(rootDir, 'src/definitely-missing/*.ts')).toBe(
      false,
    );
  });
});
