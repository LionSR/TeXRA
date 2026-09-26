import { it } from '@effect/vitest';
import { Effect, FileSystem, Layer } from 'effect';
import { describe, expect, vi } from 'vitest';

import {
  cloneOverleafProject,
  GitCloneFailed,
  type OverleafCloneWorkflowPorts,
} from '@latex/overleafClone';
import { overleafGitClone, type OverleafRemote } from '@latex/overleafProject';

import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';

const REMOTE: OverleafRemote = {
  host: 'git.overleaf.com',
  path: '/0123456789abcdef01234567',
  isOverleaf: true,
};

function createPorts(
  overrides: Partial<OverleafCloneWorkflowPorts> = {},
): OverleafCloneWorkflowPorts {
  return {
    getStoredToken: vi.fn(() =>
      Effect.succeed<string | undefined>('olp_saved'),
    ),
    deleteStoredToken: vi.fn(() => Effect.void),
    storeToken: vi.fn(() => Effect.void),
    promptToken: vi.fn(() => Effect.succeed<string | null>(null)),
    showInvalidToken: vi.fn(() => Effect.void),
    showGitMissing: vi.fn(() => Effect.void),
    listWorkspaceEntries: vi.fn(() => Effect.succeed<Iterable<string>>([])),
    showWorkspaceUnreadable: vi.fn(() => Effect.void),
    showWorkspaceNotEmpty: vi.fn(() => Effect.void),
    runClone: vi.fn(() => Effect.void),
    showCloneSucceeded: vi.fn(() => Effect.void),
    showAuthFailure: vi.fn(() => Effect.void),
    showCloneFailed: vi.fn(() => Effect.void),
    logCloneError: vi.fn(() => Effect.void),
    ...overrides,
  };
}

/** `git --version` answers with `gitExit`; the clone itself is a port, and
 *  the port doubles never touch the filesystem the workflow requires. */
function clone(ports: OverleafCloneWorkflowPorts, gitExit = 0) {
  const spawner = scriptedSpawnerLayer(() => ({ exitCode: gitExit }));
  return cloneOverleafProject(REMOTE, '/workspace', ports).pipe(
    Effect.provide(Layer.merge(spawner.layer, FileSystem.layerNoop({}))),
  );
}

describe('cloneOverleafProject', () => {
  it.effect('clones with a stored token and returns success', () =>
    Effect.gen(function* () {
      const ports = createPorts();

      expect(yield* clone(ports)).toEqual({ status: 'success' });

      expect(ports.runClone).toHaveBeenCalledWith(
        overleafGitClone(REMOTE, 'olp_saved'),
        '/workspace',
      );
      expect(ports.promptToken).not.toHaveBeenCalled();
      expect(ports.showCloneSucceeded).toHaveBeenCalledWith('Overleaf');
    }),
  );

  it.effect(
    'replaces an invalid stored token with a valid prompted token',
    () =>
      Effect.gen(function* () {
        const ports = createPorts({
          getStoredToken: vi.fn(() =>
            Effect.succeed<string | undefined>('invalid'),
          ),
          promptToken: vi.fn(() =>
            Effect.succeed<string | null>('olp_replacement'),
          ),
        });

        expect(yield* clone(ports)).toEqual({ status: 'success' });

        expect(ports.deleteStoredToken).toHaveBeenCalledWith(
          'overleaf.gitToken',
        );
        expect(ports.storeToken).toHaveBeenCalledWith(
          'overleaf.gitToken',
          'olp_replacement',
        );
      }),
  );

  it.effect('reports invalid prompted tokens without running git', () =>
    Effect.gen(function* () {
      const ports = createPorts({
        getStoredToken: vi.fn(() =>
          Effect.succeed<string | undefined>(undefined),
        ),
        promptToken: vi.fn(() =>
          Effect.succeed<string | null>('not-an-overleaf-token'),
        ),
      });

      expect(yield* clone(ports)).toEqual({ status: 'invalidToken' });

      expect(ports.showInvalidToken).toHaveBeenCalledWith(
        expect.objectContaining({ tokenKey: 'overleaf.gitToken' }),
        expect.stringContaining('Invalid token format.'),
      );
      expect(ports.runClone).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'allows platform metadata files but rejects a nonempty workspace',
    () =>
      Effect.gen(function* () {
        const allowedPorts = createPorts({
          listWorkspaceEntries: vi.fn(() =>
            Effect.succeed<Iterable<string>>(['.DS_Store', 'Thumbs.db']),
          ),
        });
        expect(yield* clone(allowedPorts)).toEqual({ status: 'success' });

        const blockedPorts = createPorts({
          getStoredToken: vi.fn(() =>
            Effect.succeed<string | undefined>(undefined),
          ),
          listWorkspaceEntries: vi.fn(() =>
            Effect.succeed<Iterable<string>>(['paper.tex']),
          ),
          promptToken: vi.fn(() =>
            Effect.succeed<string | null>('olp_prompted'),
          ),
        });
        expect(yield* clone(blockedPorts)).toEqual({
          status: 'workspaceNotEmpty',
        });
        expect(blockedPorts.showWorkspaceNotEmpty).toHaveBeenCalledOnce();
        expect(blockedPorts.promptToken).not.toHaveBeenCalled();
        expect(blockedPorts.storeToken).not.toHaveBeenCalled();
        expect(blockedPorts.runClone).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'returns explicit outcomes for unavailable git and unreadable workspaces',
    () =>
      Effect.gen(function* () {
        const gitMissingPorts = createPorts({
          getStoredToken: vi.fn(() =>
            Effect.succeed<string | undefined>(undefined),
          ),
          promptToken: vi.fn(() =>
            Effect.succeed<string | null>('olp_prompted'),
          ),
        });
        expect(yield* clone(gitMissingPorts, 127)).toEqual({
          status: 'gitMissing',
        });
        expect(gitMissingPorts.promptToken).not.toHaveBeenCalled();
        expect(gitMissingPorts.storeToken).not.toHaveBeenCalled();

        const unreadablePorts = createPorts({
          getStoredToken: vi.fn(() =>
            Effect.succeed<string | undefined>(undefined),
          ),
          listWorkspaceEntries: vi.fn(() =>
            Effect.fail(new Error('permission denied')),
          ),
          promptToken: vi.fn(() =>
            Effect.succeed<string | null>('olp_prompted'),
          ),
        });
        expect(yield* clone(unreadablePorts)).toEqual({
          status: 'workspaceUnreadable',
        });
        expect(unreadablePorts.promptToken).not.toHaveBeenCalled();
        expect(unreadablePorts.storeToken).not.toHaveBeenCalled();
        expect(unreadablePorts.showWorkspaceUnreadable).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'permission denied' }),
        );
      }),
  );

  it.effect('clears failed credentials and logs the failure', () =>
    Effect.gen(function* () {
      const ports = createPorts({
        runClone: vi.fn(() =>
          Effect.fail(
            new GitCloneFailed({
              exitCode: 128,
              message:
                "fatal: Authentication failed for 'https://git.overleaf.com/0123456789abcdef01234567/'",
            }),
          ),
        ),
      });

      expect(yield* clone(ports)).toEqual({ status: 'authFailure' });

      expect(ports.deleteStoredToken).toHaveBeenCalledWith('overleaf.gitToken');
      expect(ports.showAuthFailure).toHaveBeenCalledWith(REMOTE);
      expect(ports.logCloneError).toHaveBeenCalledWith(
        expect.stringContaining('Authentication failed'),
      );

      // A network failure on a project id containing 403 keeps the token.
      const offlinePorts = createPorts({
        runClone: vi.fn(() =>
          Effect.fail(
            new GitCloneFailed({
              exitCode: 128,
              message:
                "fatal: unable to access 'https://git.overleaf.com/40300000000000000000abcd/': Could not resolve host: git.overleaf.com",
            }),
          ),
        ),
      });
      expect(yield* clone(offlinePorts)).toEqual({ status: 'cloneFailed' });
      expect(offlinePorts.deleteStoredToken).not.toHaveBeenCalled();
      expect(offlinePorts.showCloneFailed).toHaveBeenCalled();

      // A failure before git ran (the destination's mkdir) is never an auth
      // failure, even when its path contains "auth".
      const mkdirPorts = createPorts({
        runClone: vi.fn(() =>
          Effect.fail(
            new Error(
              "EACCES: permission denied, mkdir '/home/user/coauthor-paper'",
            ),
          ),
        ),
      });
      expect(yield* clone(mkdirPorts)).toEqual({ status: 'cloneFailed' });
      expect(mkdirPorts.deleteStoredToken).not.toHaveBeenCalled();
    }),
  );
});
