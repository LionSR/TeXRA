import { it } from '@effect/vitest';
import { Effect, FileSystem, Layer, PlatformError } from 'effect';
import { describe, expect, vi } from 'vitest';

import {
  cloneOverleafProject,
  type OverleafCloneWorkflowPorts,
} from '@latex/overleafClone';
import { type OverleafRemote } from '@latex/overleafProject';

import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';

const REMOTE: OverleafRemote = {
  host: 'git.overleaf.com',
  path: '/0123456789abcdef01234567',
  isOverleaf: true,
};

function createPorts(): OverleafCloneWorkflowPorts {
  return {
    secrets: {
      get: vi.fn(() => Effect.succeed('olp_saved')),
      delete: vi.fn(() => Effect.void),
      set: vi.fn(() => Effect.void),
    },
    promptToken: vi.fn(() => Effect.succeed<string | null>(null)),
    showProgress: (clone) => clone,
  };
}

/** An empty destination that can be created, unless `fs` says otherwise. */
const destination = (fs: Partial<FileSystem.FileSystem> = {}) =>
  FileSystem.layerNoop({
    readDirectory: () => Effect.succeed([]),
    makeDirectory: () => Effect.void,
    realPath: (path) => Effect.succeed(path),
    ...fs,
  });

/** `git --version` answers with exit 0 and `git clone` with `cloneStderr`
 *  and exit 128. */
function clone(
  ports: OverleafCloneWorkflowPorts,
  cloneStderr: string,
  fs: Layer.Layer<FileSystem.FileSystem> = destination(),
) {
  const spawner = scriptedSpawnerLayer((command) =>
    command.args.includes('clone')
      ? { exitCode: 128, stderr: cloneStderr }
      : { exitCode: 0 },
  );
  return cloneOverleafProject(REMOTE, '/workspace', ports).pipe(
    Effect.provide(Layer.merge(spawner.layer, fs)),
  );
}

describe('cloneOverleafProject', () => {
  it.effect('clears failed credentials and reports the failure', () =>
    Effect.gen(function* () {
      const ports = createPorts();
      expect(
        yield* clone(
          ports,
          "fatal: Authentication failed for 'https://git.overleaf.com/0123456789abcdef01234567/'",
        ),
      ).toEqual({
        _tag: 'AuthFailure',
        error: expect.stringContaining('Authentication failed'),
      });
      expect(ports.secrets.delete).toHaveBeenCalledWith('overleaf.gitToken');

      // A network failure on a project id containing 403 keeps the token.
      const offlinePorts = createPorts();
      expect(
        yield* clone(
          offlinePorts,
          "fatal: unable to access 'https://git.overleaf.com/40300000000000000000abcd/': Could not resolve host: git.overleaf.com",
        ),
      ).toMatchObject({ _tag: 'CloneFailed' });
      expect(offlinePorts.secrets.delete).not.toHaveBeenCalled();

      // A failure before git ran (the destination's mkdir) is never an auth
      // failure, even when its path contains "auth".
      const mkdirPorts = createPorts();
      expect(
        yield* clone(
          mkdirPorts,
          'fatal: Authentication failed for the clone that never ran',
          destination({
            makeDirectory: () =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: 'PermissionDenied',
                  module: 'FileSystem',
                  method: 'makeDirectory',
                  pathOrDescriptor: '/home/user/coauthor-paper',
                  description:
                    "EACCES: permission denied, mkdir '/home/user/coauthor-paper'",
                }),
              ),
          }),
        ),
      ).toMatchObject({ _tag: 'CloneFailed' });
      expect(mkdirPorts.secrets.delete).not.toHaveBeenCalled();
    }),
  );
});
