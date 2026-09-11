import * as path from 'node:path';

import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errnoError } from '@test/support/fsTestUtils';

const fsState = vi.hoisted(() => ({
  workspacePath: '/workspace' as string | undefined,
  homeDirectory: undefined as string | undefined,
  workspaceFiles: new Map<string, string>(),
  workspaceReadErrors: new Map<string, Error>(),
  absoluteFiles: new Map<string, string>(),
  absoluteReadErrors: new Map<string, Error>(),
  reset(): void {
    this.workspacePath = '/workspace';
    this.homeDirectory = undefined;
    this.workspaceFiles.clear();
    this.workspaceReadErrors.clear();
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
      exists: async (relativePath: string) =>
        fsState.workspaceFiles.has(relativePath.replace(/^\/+/, '')),
      read: async (relativePath: string) => {
        const normalized = relativePath.replace(/^\/+/, '');
        return readFrom(
          fsState.workspaceFiles,
          fsState.workspaceReadErrors,
          normalized,
        );
      },
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

async function loadMatcher() {
  vi.resetModules();
  const { getGitignoreMatcher } = await import('@tools/gitignore');
  return Effect.runPromise(getGitignoreMatcher());
}

async function loadWorkspaceMatcher(gitignore: string) {
  fsState.workspaceFiles.set('.gitignore', gitignore);
  return loadMatcher();
}

type Matcher = Awaited<ReturnType<typeof loadMatcher>>;

function expectEmptyMatcher(matcher: Matcher): void {
  expect(matcher.ignoreFiles).toEqual([]);
  expect(matcher.ignores('paper.tex')).toBe(false);
}

describe('getGitignoreMatcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('ignore');
    fsState.reset();
  });

  it('uses an empty matcher when no workspace is available', async () => {
    fsState.workspacePath = undefined;

    expectEmptyMatcher(await loadMatcher());
  });

  it('uses an empty matcher when all ignore policies are absent', async () => {
    fsState.homeDirectory = path.join(path.sep, 'home', 'user');

    expectEmptyMatcher(await loadMatcher());
  });

  it('rejects when a workspace ignore policy cannot be read', async () => {
    const error = errnoError('EACCES', 'Permission denied');
    fsState.workspaceReadErrors.set('.gitignore', error);

    await expect(loadMatcher()).rejects.toBe(error);
  });

  it('rejects when a global ignore policy cannot be read', async () => {
    const error = errnoError('EACCES', 'Permission denied');
    fsState.homeDirectory = path.join(path.sep, 'home', 'user');
    fsState.absoluteReadErrors.set(
      path.join(path.sep, 'home', 'user', '.gitignore_global'),
      error,
    );

    await expect(loadMatcher()).rejects.toBe(error);
  });

  it('rereads the ignore policy on every call', async () => {
    vi.resetModules();
    const { getGitignoreMatcher } = await import('@tools/gitignore');
    fsState.workspaceFiles.set('.gitignore', 'dist/\n');
    const before = await Effect.runPromise(getGitignoreMatcher());

    fsState.workspaceFiles.set('.gitignore', 'build/\n');
    const after = await Effect.runPromise(getGitignoreMatcher());

    expect(before.ignores('dist')).toBe(true);
    expect(after.ignores('dist')).toBe(false);
    expect(after.ignores('build')).toBe(true);
  });
});
