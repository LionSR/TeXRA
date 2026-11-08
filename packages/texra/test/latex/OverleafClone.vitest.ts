import { it } from '@effect/vitest';
import { Effect, FileSystem, Layer } from 'effect';
import { describe, expect, vi } from 'vitest';

import {
  cloneOverleafProject,
  GitCloneFailed,
  type OverleafCloneWorkflowPorts,
} from '@latex/overleafClone';
import { type OverleafRemote } from '@latex/overleafProject';

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
    secrets: {
      get: vi.fn(() => Effect.succeed('olp_saved')),
      delete: vi.fn(() => Effect.void),
      set: vi.fn(() => Effect.void),
    },
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

/** `git --version` answers with exit 0; the clone itself is a port, and
 *  the port doubles never touch the filesystem the workflow requires. */
function clone(ports: OverleafCloneWorkflowPorts) {
  const spawner = scriptedSpawnerLayer(() => ({ exitCode: 0 }));
  return cloneOverleafProject(REMOTE, '/workspace', ports).pipe(
    Effect.provide(Layer.merge(spawner.layer, FileSystem.layerNoop({}))),
  );
}

describe('cloneOverleafProject', () => {
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

      expect(ports.secrets.delete).toHaveBeenCalledWith('overleaf.gitToken');
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
      expect(offlinePorts.secrets.delete).not.toHaveBeenCalled();

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
      expect(mkdirPorts.secrets.delete).not.toHaveBeenCalled();
    }),
  );
});
