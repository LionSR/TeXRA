import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

type TsconfigPaths = Record<string, string[]>;

interface AliasUtilsModule {
  deriveBuildPaths(rootPaths: TsconfigPaths): TsconfigPaths;
  deriveDesktopPaths(rootPaths: TsconfigPaths): TsconfigPaths;
  loadRootPaths(rootDir: string): TsconfigPaths;
  parseJsonc(text: string): unknown;
  pathTargetExists(rootDir: string, target: string): boolean;
}

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
const {
  deriveBuildPaths,
  deriveDesktopPaths,
  loadRootPaths,
  parseJsonc,
  pathTargetExists,
} = (await import(
  pathToFileURL(resolve(rootDir, 'scripts/aliasUtils.mjs')).href
)) as AliasUtilsModule;

const SAMPLE_ROOT_PATHS = {
  '@/*': ['./packages/extension/src/*', './src/*'],
  '@shared/*': ['./src/shared/*'],
  '@commands/*': ['./packages/extension/src/commands/*'],
  '@test/*': ['./src/test-kernel/*'],
  '@cli/*': ['./packages/cli/src/*'],
  '@desktop/*': ['./packages/desktop/src/*'],
};

describe('aliasUtils deriveDesktopPaths', () => {
  const result = deriveDesktopPaths(SAMPLE_ROOT_PATHS);

  it('prefixes every value with ./../../ so it stays repo-root-relative', () => {
    expect(result['@shared/*']).toEqual(['./../../src/shared/*']);
    expect(result['@/*']).toEqual([
      './../../packages/extension/src/*',
      './../../src/*',
    ]);
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
});
