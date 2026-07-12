// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({
  workspacePath: '/workspace' as string | undefined,
  homeDirectory: undefined as string | undefined,
  workspaceFiles: new Map<string, string>(),
  workspaceReadErrors: new Map<string, Error>(),
  absoluteFiles: new Map<string, string>(),
  absoluteReadErrors: new Map<string, Error>(),
}));

vi.mock('@utils/files', () => ({
  WorkspaceFS: {
    getPath: () => fsState.workspacePath,
    exists: async (relativePath: string) =>
      fsState.workspaceFiles.has(relativePath.replace(/^\/+/, '')),
    read: async (relativePath: string) => {
      const normalized = relativePath.replace(/^\/+/, '');
      const readError = fsState.workspaceReadErrors.get(normalized);
      if (readError) {
        throw readError;
      }
      const content = fsState.workspaceFiles.get(normalized);
      if (content === undefined) {
        throw Object.assign(new Error(`File not found: ${normalized}`), {
          code: 'ENOENT',
        });
      }
      return content;
    },
  },
  AbsoluteFS: {
    exists: async (absolutePath: string) =>
      fsState.absoluteFiles.has(absolutePath),
    read: async (absolutePath: string) => {
      const readError = fsState.absoluteReadErrors.get(absolutePath);
      if (readError) {
        throw readError;
      }
      const content = fsState.absoluteFiles.get(absolutePath);
      if (content === undefined) {
        throw Object.assign(new Error(`File not found: ${absolutePath}`), {
          code: 'ENOENT',
        });
      }
      return content;
    },
  },
}));

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

describe('getGitignoreMatcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('ignore');
    fsState.workspacePath = '/workspace';
    fsState.homeDirectory = undefined;
    fsState.workspaceFiles.clear();
    fsState.workspaceReadErrors.clear();
    fsState.absoluteFiles.clear();
    fsState.absoluteReadErrors.clear();
  });

  it('uses an empty matcher when no workspace is available', async () => {
    fsState.workspacePath = undefined;

    const matcher = await loadMatcher();

    expect(matcher.hasRules).toBe(false);
    expect(matcher.ignoreFiles).toEqual([]);
    expect(matcher.ignores('paper.tex')).toBe(false);
  });

  it('uses an empty matcher when all ignore policies are absent', async () => {
    fsState.homeDirectory = '/home/user';

    const matcher = await loadMatcher();

    expect(matcher.hasRules).toBe(false);
    expect(matcher.ignoreFiles).toEqual([]);
    expect(matcher.ignores('paper.tex')).toBe(false);
  });

  it('rejects when a workspace ignore policy cannot be read', async () => {
    const readError = Object.assign(new Error('Permission denied'), {
      code: 'EACCES',
    });
    fsState.workspaceReadErrors.set('.gitignore', readError);

    await expect(loadMatcher()).rejects.toBe(readError);
  });

  it('rejects when a global ignore policy cannot be read', async () => {
    const readError = Object.assign(new Error('Permission denied'), {
      code: 'EACCES',
    });
    fsState.homeDirectory = '/home/user';
    fsState.absoluteReadErrors.set('/home/user/.gitignore_global', readError);

    await expect(loadMatcher()).rejects.toBe(readError);
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

describe('createGlobMatcher', () => {
  it('does not apply basename matching to slash-containing patterns', async () => {
    const { createGlobMatcher } = await import('@tools/utils');
    const matcher = createGlobMatcher('src/*.js');

    expect(matcher('src/foo.js')).toBe(true);
    expect(matcher('lib/foo.js')).toBe(false);
    expect(matcher('foo.js')).toBe(false);
  });

  it('keeps basename matching for slash-free patterns', async () => {
    const { createGlobMatcher } = await import('@tools/utils');
    const matcher = createGlobMatcher('*.js');

    expect(matcher('foo.js')).toBe(true);
    expect(matcher('src/foo.js')).toBe(true);
  });
});
