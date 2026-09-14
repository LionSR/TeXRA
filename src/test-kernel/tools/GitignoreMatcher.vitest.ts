import * as path from 'node:path';

import { Cause, Effect, Exit } from 'effect';
import { it } from '@effect/vitest';
import { beforeEach, describe, expect, vi } from 'vitest';

import { errnoError } from '@test/support/fsTestUtils';
import { getGitignoreMatcher } from '@tools/gitignore';

const fsState = vi.hoisted(() => ({
  workspacePath: '/workspace' as string | undefined,
  homeDirectory: undefined as string | undefined,
  absoluteFiles: new Map<string, string>(),
  absoluteReadErrors: new Map<string, Error>(),
  reset(): void {
    this.workspacePath = '/workspace';
    this.homeDirectory = undefined;
    this.absoluteFiles.clear();
    this.absoluteReadErrors.clear();
  },
}));

const readFrom = vi.hoisted(
  () =>
    async (
      files: Map<string, string>,
      errors: Map<string, Error>,
      filePath: string,
    ): Promise<string> => {
      const readError = errors.get(filePath);
      if (readError) {
        throw readError;
      }
      const content = files.get(filePath);
      if (content === undefined) {
        throw Object.assign(new Error(`File not found: ${filePath}`), {
          code: 'ENOENT',
        });
      }
      return content;
    },
);

vi.mock('@utils/files/workspaceFS', () => {
  return {
    WorkspaceFS: {
      getPath: () => fsState.workspacePath,
    },
  };
});

vi.mock('@utils/files/absoluteFS', () => {
  return {
    AbsoluteFS: {
      exists: async (absolutePath: string) =>
        fsState.absoluteFiles.has(absolutePath),
      read: async (absolutePath: string) =>
        readFrom(
          fsState.absoluteFiles,
          fsState.absoluteReadErrors,
          absolutePath,
        ),
    },
  };
});

vi.mock('@utils/system/platformPaths', () => ({
  safeHomedir: () => fsState.homeDirectory,
}));

type Matcher = Effect.Success<ReturnType<typeof getGitignoreMatcher>>;

function expectEmptyMatcher(matcher: Matcher): void {
  expect(matcher.ignoreFiles).toEqual([]);
  expect(matcher.ignores('paper.tex')).toBe(false);
}

describe('getGitignoreMatcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    fsState.reset();
  });

  it.effect('uses an empty matcher when no workspace is available', () =>
    Effect.gen(function* () {
      fsState.workspacePath = undefined;
      expectEmptyMatcher(yield* getGitignoreMatcher());
    }),
  );

  it.effect('uses an empty matcher when all ignore policies are absent', () =>
    Effect.gen(function* () {
      fsState.homeDirectory = path.join(path.sep, 'home', 'user');
      expectEmptyMatcher(yield* getGitignoreMatcher());
    }),
  );

  it.effect.each(['workspace', 'global'] as const)(
    'rejects when a %s ignore policy cannot be read',
    (kind) =>
      Effect.gen(function* () {
        const error = errnoError('EACCES', 'Permission denied');
        fsState.homeDirectory = path.join(path.sep, 'home', 'user');
        const filePath =
          kind === 'workspace'
            ? path.join('/workspace', '.gitignore')
            : path.join(fsState.homeDirectory, '.gitignore_global');
        fsState.absoluteReadErrors.set(filePath, error);
        const result = yield* Effect.exit(getGitignoreMatcher());
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toBe(error);
      }),
  );

  it.effect('rereads the ignore policy on every call', () =>
    Effect.gen(function* () {
      fsState.absoluteFiles.set(
        path.join('/workspace', '.gitignore'),
        'dist/\n',
      );
      const before = yield* getGitignoreMatcher();
      fsState.absoluteFiles.set(
        path.join('/workspace', '.gitignore'),
        'build/\n',
      );
      const after = yield* getGitignoreMatcher();
      expect(before.ignores('dist')).toBe(true);
      expect(after.ignores('dist')).toBe(false);
      expect(after.ignores('build')).toBe(true);
    }),
  );
});
