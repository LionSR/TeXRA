// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import {
  cloneOverleafProject,
  type OverleafCloneWorkflowPorts,
} from '@latex/overleafClone';
import type { OverleafRemote } from '@latex/overleafProject';

const REMOTE: OverleafRemote = {
  host: 'git.overleaf.com',
  path: '/0123456789abcdef01234567',
  isOverleaf: true,
};

function createPorts(
  overrides: Partial<OverleafCloneWorkflowPorts> = {},
): OverleafCloneWorkflowPorts {
  return {
    getStoredToken: vi.fn(async () => 'olp_saved'),
    deleteStoredToken: vi.fn(async () => undefined),
    storeToken: vi.fn(async () => undefined),
    promptToken: vi.fn(async () => null),
    showInvalidToken: vi.fn(async () => undefined),
    isGitAvailable: vi.fn(() => true),
    showGitMissing: vi.fn(async () => undefined),
    listWorkspaceEntries: vi.fn(async () => []),
    showWorkspaceUnreadable: vi.fn(),
    showWorkspaceNotEmpty: vi.fn(),
    runClone: vi.fn(async () => undefined),
    showCloneSucceeded: vi.fn(),
    showAuthFailure: vi.fn(async () => undefined),
    showCloneFailed: vi.fn(),
    logCloneError: vi.fn(),
    ...overrides,
  };
}

describe('cloneOverleafProject', () => {
  it('clones with a stored token and returns success', async () => {
    const ports = createPorts();

    await expect(
      cloneOverleafProject(REMOTE, '/workspace', ports),
    ).resolves.toEqual({ status: 'success' });

    expect(ports.runClone).toHaveBeenCalledWith(
      `https://git:olp_saved@git.overleaf.com${REMOTE.path}`,
      '/workspace',
    );
    expect(ports.promptToken).not.toHaveBeenCalled();
    expect(ports.showCloneSucceeded).toHaveBeenCalledWith('Overleaf');
  });

  it('replaces an invalid stored token with a valid prompted token', async () => {
    const ports = createPorts({
      getStoredToken: vi.fn(async () => 'invalid'),
      promptToken: vi.fn(async () => 'olp_replacement'),
    });

    await expect(
      cloneOverleafProject(REMOTE, '/workspace', ports),
    ).resolves.toEqual({ status: 'success' });

    expect(ports.deleteStoredToken).toHaveBeenCalledWith('overleaf.gitToken');
    expect(ports.storeToken).toHaveBeenCalledWith(
      'overleaf.gitToken',
      'olp_replacement',
    );
  });

  it('reports invalid prompted tokens without running git', async () => {
    const ports = createPorts({
      getStoredToken: vi.fn(async () => undefined),
      promptToken: vi.fn(async () => 'not-an-overleaf-token'),
    });

    await expect(
      cloneOverleafProject(REMOTE, '/workspace', ports),
    ).resolves.toEqual({ status: 'invalidToken' });

    expect(ports.showInvalidToken).toHaveBeenCalledWith(
      expect.objectContaining({ tokenKey: 'overleaf.gitToken' }),
      expect.stringContaining('Invalid token format.'),
    );
    expect(ports.runClone).not.toHaveBeenCalled();
  });

  it('allows platform metadata files but rejects a nonempty workspace', async () => {
    const allowedPorts = createPorts({
      listWorkspaceEntries: vi.fn(async () => ['.DS_Store', 'Thumbs.db']),
    });
    await expect(
      cloneOverleafProject(REMOTE, '/workspace', allowedPorts),
    ).resolves.toEqual({ status: 'success' });

    const blockedPorts = createPorts({
      listWorkspaceEntries: vi.fn(async () => ['paper.tex']),
    });
    await expect(
      cloneOverleafProject(REMOTE, '/workspace', blockedPorts),
    ).resolves.toEqual({ status: 'workspaceNotEmpty' });
    expect(blockedPorts.showWorkspaceNotEmpty).toHaveBeenCalledOnce();
    expect(blockedPorts.runClone).not.toHaveBeenCalled();
  });

  it('returns explicit outcomes for unavailable git and unreadable workspaces', async () => {
    const gitMissingPorts = createPorts({
      isGitAvailable: vi.fn(() => false),
    });
    await expect(
      cloneOverleafProject(REMOTE, '/workspace', gitMissingPorts),
    ).resolves.toEqual({ status: 'gitMissing' });

    const unreadablePorts = createPorts({
      listWorkspaceEntries: vi.fn(async () => {
        throw new Error('permission denied');
      }),
    });
    await expect(
      cloneOverleafProject(REMOTE, '/workspace', unreadablePorts),
    ).resolves.toEqual({ status: 'workspaceUnreadable' });
    expect(unreadablePorts.showWorkspaceUnreadable).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'permission denied' }),
    );
  });

  it('clears failed credentials and redacts them from logs', async () => {
    const ports = createPorts({
      getStoredToken: vi.fn(async () => 'olp_secret'),
      runClone: vi.fn(async () => {
        throw new Error(
          'fatal: auth failed for https://git:olp_secret@git.overleaf.com',
        );
      }),
    });

    await expect(
      cloneOverleafProject(REMOTE, '/workspace', ports),
    ).resolves.toEqual({ status: 'authFailure' });

    expect(ports.deleteStoredToken).toHaveBeenCalledWith('overleaf.gitToken');
    expect(ports.showAuthFailure).toHaveBeenCalledWith(REMOTE);
    expect(ports.logCloneError).toHaveBeenCalledWith(
      expect.not.stringContaining('olp_secret'),
    );
  });
});
