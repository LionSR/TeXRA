import * as path from 'node:path';

import { Cause, Effect, Exit, FileSystem, PlatformError } from 'effect';
import { it } from '@effect/vitest';
import { beforeEach, describe, expect, vi } from 'vitest';

import { getGitignoreMatcher } from '@tools/gitignore';

const fsState = vi.hoisted(() => ({
  workspacePath: '/workspace' as string | undefined,
  homeDirectory: undefined as string | undefined,
  files: new Map<string, string>(),
  readFailures: new Map<string, PlatformError.PlatformError>(),
  reset(): void {
    this.workspacePath = '/workspace';
    this.homeDirectory = undefined;
    this.files.clear();
    this.readFailures.clear();
  },
}));

vi.mock('@utils/files/workspaceFS', () => {
  return {
    WorkspaceFS: {
      getPath: () => fsState.workspacePath,
    },
  };
});

vi.mock('@utils/system/platformPaths', () => ({
  safeHomedir: () => fsState.homeDirectory,
}));

function systemFailure(
  tag: PlatformError.SystemErrorTag,
  filePath: string,
): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: tag,
    module: 'FileSystem',
    method: 'readFileString',
    pathOrDescriptor: filePath,
  });
}

/**
 * The policy files as the process filesystem serves them: a seeded path reads
 * back, a path with a seeded failure raises it, and anything else is absent —
 * the `NotFound` reason the matcher treats as "no policy here".
 */
const policyFiles = FileSystem.layerNoop({
  readFileString: (filePath: string) => {
    const failure = fsState.readFailures.get(filePath);
    if (failure) return Effect.fail(failure);
    const content = fsState.files.get(filePath);
    return content === undefined
      ? Effect.fail(systemFailure('NotFound', filePath))
      : Effect.succeed(content);
  },
});

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
    }).pipe(Effect.provide(policyFiles)),
  );

  it.effect('uses an empty matcher when all ignore policies are absent', () =>
    Effect.gen(function* () {
      fsState.homeDirectory = path.join(path.sep, 'home', 'user');
      expectEmptyMatcher(yield* getGitignoreMatcher());
    }).pipe(Effect.provide(policyFiles)),
  );

  it.effect.each(['workspace', 'global'] as const)(
    'rejects when a %s ignore policy cannot be read',
    (kind) =>
      Effect.gen(function* () {
        fsState.homeDirectory = path.join(path.sep, 'home', 'user');
        const filePath =
          kind === 'workspace'
            ? path.join('/workspace', '.gitignore')
            : path.join(fsState.homeDirectory, '.gitignore_global');
        const failure = systemFailure('PermissionDenied', filePath);
        fsState.readFailures.set(filePath, failure);
        const result = yield* Effect.exit(getGitignoreMatcher());
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toBe(failure);
      }).pipe(Effect.provide(policyFiles)),
  );

  it.effect('rereads the ignore policy on every call', () =>
    Effect.gen(function* () {
      fsState.files.set(path.join('/workspace', '.gitignore'), 'dist/\n');
      const before = yield* getGitignoreMatcher();
      fsState.files.set(path.join('/workspace', '.gitignore'), 'build/\n');
      const after = yield* getGitignoreMatcher();
      expect(before.ignores('dist')).toBe(true);
      expect(after.ignores('dist')).toBe(false);
      expect(after.ignores('build')).toBe(true);
    }).pipe(Effect.provide(policyFiles)),
  );
});
