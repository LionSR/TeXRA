// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { assert, beforeEach, describe, expect, vi } from 'vitest';

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
  const sessionHandle = await import('@agent/runtime/SessionHandle');
  const graph = await import('@agent/runtime/sessionGraph');
  const { testWorkspaceRoots } =
    await import('@test/support/testWorkspaceRoots');
  return {
    ...sessionHandle,
    initializeDefaultSession: graph.initializeDefaultSession,
    teardownDefaultSession: graph.teardownDefaultSession,
    tryDefaultSession: graph.tryDefaultSession,
    roots: testWorkspaceRoots(),
  };
}

describe('default session lifecycle', () => {
  // Opens and releases a real session on the process session owner, and keeps
  // the real clock it runs on today.
  it.live('exposes no default before explicit initialization', () =>
    Effect.gen(function* () {
      const {
        initializeDefaultSession,
        teardownDefaultSession,
        tryDefaultSession,
        roots,
      } = yield* Effect.promise(() => importSessionRuntime());

      expect(tryDefaultSession()).toBeUndefined();

      const transcriptMode = {
        kind: 'ephemeral',
        reason: 'default session lifecycle test',
      } as const;
      const session = yield* initializeDefaultSession({
        roots,
        transcriptMode,
      });
      yield* Effect.gen(function* () {
        expect(tryDefaultSession()).toBe(session);
        expect(session.transcripts.mode).toEqual(transcriptMode);
        // `initializeDefaultSession` carries no error channel and a second
        // initialization dies (SessionHandle.ts:1403-1415), so the assertion
        // reads the exit and its die reason rather than `Effect.flip`.
        const exit = yield* Effect.exit(
          initializeDefaultSession({ roots, transcriptMode }),
        );
        assert(Exit.isFailure(exit));
        const defect = exit.cause.reasons.find(Cause.isDieReason)?.defect;
        expect(defect).toBeInstanceOf(Error);
        expect((defect as Error).message).toContain('already been initialized');
      }).pipe(Effect.ensuring(teardownDefaultSession()));
    }),
  );

  it.live(
    'retains the roots it was opened over until the owner closes it after a host swap',
    () =>
      Effect.gen(function* () {
        const { initializeDefaultSession } = yield* Effect.promise(() =>
          importSessionRuntime(),
        );
        const { installPlatform } = yield* Effect.promise(
          () => import('@test/support/setupPlatform'),
        );
        const { closeSession, listSessions } = yield* Effect.promise(
          () => import('@agent/runtime/sessionGraph'),
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
          workspace: installedRoots.workspace,
          storage: installedRoots.storage,
          globalStorage: installedRoots.globalStorage,
          config: installedRoots.config,
          workspaceState: installedRoots.workspaceState,
          globalState: installedRoots.globalState,
        } satisfies WorkspaceRoots;
        // The opener may hand over a record whose slots are inherited rather
        // than own: the session snapshots them structurally, so a later host
        // swap cannot move the root its owner keys it by.
        const roots = Object.create(installedRoots) as WorkspaceRoots;
        expect(Object.keys(roots)).toEqual([]);
        const session = yield* initializeDefaultSession({
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
          expect(yield* listSessions()).toEqual([session]);
          expect(yield* closeSession(originalStorage)).toEqual({
            settled: true,
            abandoned: [],
          });
          expect(yield* listSessions()).toEqual([]);
        } finally {
          yield* closeSession(originalStorage);
        }
      }),
  );

  // `closeSession` forks a real-time `Effect.sleep` deadline budget and
  // races it against settlement promises, so this test needs the live clock.
  it.live('can initialize again only after explicit teardown', () =>
    Effect.gen(function* () {
      const {
        initializeDefaultSession,
        teardownDefaultSession,
        tryDefaultSession,
        roots,
      } = yield* Effect.promise(() => importSessionRuntime());

      const first = yield* initializeDefaultSession({
        roots,
        transcriptMode: { kind: 'ephemeral', reason: 'first activation' },
      });
      // `initializeDefaultSession` carries no error channel and a second
      // initialization dies (SessionHandle.ts:1403-1415), so the assertion
      // reads the exit and its die reason rather than `Effect.flip`.
      const exit = yield* Effect.exit(
        initializeDefaultSession({
          roots,
          transcriptMode: {
            kind: 'ephemeral',
            reason: 'replacement attempt',
          },
        }),
      );
      assert(Exit.isFailure(exit));
      const defect = exit.cause.reasons.find(Cause.isDieReason)?.defect;
      expect(defect).toBeInstanceOf(Error);
      expect((defect as Error).message).toContain('already been initialized');

      const disposeSpy = vi.spyOn(first, 'dispose');

      yield* teardownDefaultSession();

      expect(disposeSpy).toHaveBeenCalledOnce();
      expect(tryDefaultSession()).toBeUndefined();

      const second = yield* initializeDefaultSession({
        roots,
        transcriptMode: { kind: 'ephemeral', reason: 'second activation' },
      });
      try {
        expect(tryDefaultSession()).toBe(second);
        expect(second).not.toBe(first);
        // The default session is read from its owner: closing its root
        // through the owner leaves no default session behind.
        const { closeSession } = yield* Effect.promise(
          () => import('@agent/runtime/sessionGraph'),
        );
        yield* closeSession(roots.storage);
        expect(tryDefaultSession()).toBeUndefined();
      } finally {
        yield* teardownDefaultSession();
      }
    }),
  );
});
