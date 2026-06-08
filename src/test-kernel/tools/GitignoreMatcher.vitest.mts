// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({
  workspacePath: '/workspace',
  workspaceFiles: new Map<string, string>(),
  absoluteFiles: new Map<string, string>(),
}));

vi.mock('@utils/files', () => ({
  WorkspaceFS: {
    getPath: () => fsState.workspacePath,
    exists: async (relativePath: string) =>
      fsState.workspaceFiles.has(relativePath.replace(/^\/+/, '')),
    read: async (relativePath: string) =>
      fsState.workspaceFiles.get(relativePath.replace(/^\/+/, '')) ?? '',
  },
  AbsoluteFS: {
    exists: async (absolutePath: string) =>
      fsState.absoluteFiles.has(absolutePath),
    read: async (absolutePath: string) =>
      fsState.absoluteFiles.get(absolutePath) ?? '',
  },
}));

vi.mock('@utils/system/platformPaths', () => ({
  safeHomedir: () => undefined,
}));

async function loadWorkspaceMatcher(gitignore: string) {
  vi.resetModules();
  fsState.workspacePath = '/workspace';
  fsState.workspaceFiles.clear();
  fsState.absoluteFiles.clear();
  fsState.workspaceFiles.set('.gitignore', gitignore);

  const { getGitignoreMatcher } = await import('@tools/gitignore');
  return getGitignoreMatcher();
}

describe('getGitignoreMatcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
