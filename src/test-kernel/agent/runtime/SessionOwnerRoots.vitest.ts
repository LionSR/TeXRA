// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import type { WorkspaceRoots } from '@platform/workspaceRoots';

beforeEach(() => {
  vi.resetModules();
});

/** Fresh module instances per test (beforeEach resets the module registry). */
async function importSessionRuntime() {
  // The reset also emptied the harness's roots holder, which is where these
  // tests name the roots they open a session over; reinstall the suite
  // default into it.
  const { installPlatform } = await import('@test/support/setupPlatform');
  await installPlatform();
  await import('@test/support/sessionGraphTestSetup');
  return import('@test/support/sessionEnd');
}

describe('session owner roots', () => {
  it.live(
    'retains the roots it was opened over until the owner closes it after a host swap',
    () =>
      Effect.gen(function* () {
        const { openTestSession, listTestSessions, closeTestSession } =
          yield* Effect.promise(() => importSessionRuntime());
        const { installPlatform } = yield* Effect.promise(
          () => import('@test/support/setupPlatform'),
        );
        const originalStorage = '/workspace/first/.texra/storage';

        yield* Effect.promise(() =>
          installPlatform({ storagePath: originalStorage }),
        );
        const installedRoots = yield* Effect.promise(async () => {
          const { testWorkspaceRoots } =
            await import('@test/support/testWorkspaceRoots');
          return testWorkspaceRoots();
        });
        const originalRoots = {
          host: installedRoots.host,
          workspace: installedRoots.workspace,
          storage: installedRoots.storage,
          globalStorage: installedRoots.globalStorage,
          config: installedRoots.config,
          workspaceState: installedRoots.workspaceState,
          repoState: installedRoots.repoState,
          globalState: installedRoots.globalState,
        } satisfies WorkspaceRoots;
        // The opener may hand over a record whose slots are inherited rather
        // than own: the session snapshots them structurally, so a later host
        // swap cannot move the root its owner keys it by.
        const roots = Object.create(installedRoots) as WorkspaceRoots;
        expect(Object.keys(roots)).toEqual([]);
        const session = yield* openTestSession({
          roots,
          transcriptMode: { kind: 'ephemeral', reason: 'root snapshot test' },
        });
        try {
          yield* Effect.promise(() =>
            installPlatform({
              storagePath: '/workspace/second/.texra/storage',
            }),
          );

          expect(session.roots).toEqual(originalRoots);
          expect(yield* listTestSessions).toEqual([session]);
          expect(yield* closeTestSession(originalStorage)).toEqual({
            settled: true,
            abandoned: [],
          });
          expect(yield* listTestSessions).toEqual([]);
        } finally {
          yield* closeTestSession(originalStorage);
        }
      }),
  );
});
