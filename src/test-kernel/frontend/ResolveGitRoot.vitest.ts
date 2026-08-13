// Third-party imports
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  default: {},
  extensions: {},
  workspace: {},
  Uri: {},
  FileType: { File: 1, Directory: 2 },
}));

// Local imports - extension frontend
import { resolveCommonRootFromGitdir } from '@frontend/git/resolveGitRoot';

describe('resolveCommonRootFromGitdir', () => {
  it('uses the main repository root for git worktree gitdir files', () => {
    expect(
      resolveCommonRootFromGitdir(
        '/repo/feature-worktree',
        '/repo/main/.git/worktrees/feature-worktree',
      ),
    ).toBe('/repo/main');
  });

  it('keeps submodules scoped to their own repository root', () => {
    expect(
      resolveCommonRootFromGitdir(
        '/repo/main/deps/submodule',
        '/repo/main/.git/modules/deps/submodule',
      ),
    ).toBe('/repo/main/deps/submodule');
  });
});
