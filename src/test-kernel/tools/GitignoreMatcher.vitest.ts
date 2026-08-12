import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({
  workspacePath: '/workspace' as string | undefined,
  homeDirectory: undefined as string | undefined,
  workspaceFiles: new Map<string, string>(),
  workspaceReadErrors: new Map<string, Error>(),
  workspaceReadCounts: new Map<string, number>(),
  absoluteFiles: new Map<string, string>(),
  absoluteReadErrors: new Map<string, Error>(),
  reset(): void {
    this.workspacePath = '/workspace';
    this.homeDirectory = undefined;
    this.workspaceFiles.clear();
    this.workspaceReadErrors.clear();
    this.workspaceReadCounts.clear();
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
        fsState.workspaceReadCounts.set(
          normalized,
          (fsState.workspaceReadCounts.get(normalized) ?? 0) + 1,
        );
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
  return getGitignoreMatcher();
}

async function loadWorkspaceMatcher(gitignore: string) {
  fsState.workspaceFiles.set('.gitignore', gitignore);
  return loadMatcher();
}

type Matcher = Awaited<ReturnType<typeof loadMatcher>>;

function expectEmptyMatcher(matcher: Matcher): void {
  expect(matcher.hasRules).toBe(false);
  expect(matcher.ignoreFiles).toEqual([]);
  expect(matcher.ignores('paper.tex')).toBe(false);
}

function eaccesError(message: string): Error {
  return Object.assign(new Error(message), { code: 'EACCES' });
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
    const error = eaccesError('Permission denied');
    fsState.workspaceReadErrors.set('.gitignore', error);

    await expect(loadMatcher()).rejects.toBe(error);
  });

  it('rejects when a global ignore policy cannot be read', async () => {
    const error = eaccesError('Permission denied');
    fsState.homeDirectory = path.join(path.sep, 'home', 'user');
    fsState.absoluteReadErrors.set(
      path.join(path.sep, 'home', 'user', '.gitignore_global'),
      error,
    );

    await expect(loadMatcher()).rejects.toBe(error);
  });

  it('rejects when ignore policy construction fails', async () => {
    const constructionError = new Error('Invalid ignore policy');
    vi.doMock('ignore', () => ({
      default: () => ({
        add: () => {
          throw constructionError;
        },
      }),
    }));
    fsState.workspaceFiles.set('.gitignore', 'dist/\n');

    await expect(loadMatcher()).rejects.toBe(constructionError);
  });

  it('retries after a failed shared load attempt', async () => {
    const error = eaccesError('Temporarily unavailable');
    fsState.workspaceFiles.set('.gitignore', 'dist/\n');
    fsState.workspaceReadErrors.set('.gitignore', error);
    vi.resetModules();
    const { getGitignoreMatcher } = await import('@tools/gitignore');

    const failedCalls = await Promise.allSettled([
      getGitignoreMatcher(),
      getGitignoreMatcher(),
    ]);

    for (const result of failedCalls) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toBe(error);
      }
    }
    expect(fsState.workspaceReadCounts.get('.gitignore')).toBe(1);

    fsState.workspaceReadErrors.delete('.gitignore');
    const [matcher, concurrentMatcher] = await Promise.all([
      getGitignoreMatcher(),
      getGitignoreMatcher(),
    ]);

    expect(matcher).toBe(concurrentMatcher);
    expect(matcher.ignores('dist')).toBe(true);
    expect(fsState.workspaceReadCounts.get('.gitignore')).toBe(2);
  });

  it('preserves directory-only rules for bare directory entries', async () => {
    const matcher = await loadWorkspaceMatcher('dist/\n');

    expect(matcher.ignores('dist')).toBe(true);
    expect(matcher.ignores('dist/output.txt')).toBe(true);
  });

  it('keeps valid negated file patterns unignored', async () => {
    const matcher = await loadWorkspaceMatcher('*.log\n!important.log\n');

    expect(matcher.ignores('debug.log')).toBe(true);
    expect(matcher.ignores('important.log')).toBe(false);
  });

  it('follows gitignore semantics for negations inside ignored directories', async () => {
    const matcher = await loadWorkspaceMatcher('dist/\n!dist/.gitkeep\n');

    expect(matcher.ignores('dist/.gitkeep')).toBe(true);
  });

  it('propagates matcher failures', async () => {
    const matcher = await loadWorkspaceMatcher('dist/\n');

    expect(() => matcher.ignores('../outside')).toThrow(
      'path should be a `path.relative()`d string',
    );
  });
});
