import { it } from '@effect/vitest';
import { Effect } from 'effect';
import '@test/support/defaultSessionTestSetup';

import { describe, expect, vi } from 'vitest';

import {
  createRunContext,
  runInSession,
  withRunContext,
} from '@agent/runtime/RunContext';
import {
  currentSession,
  defaultSession,
  settleLiveSessionRuns,
} from '@agent/runtime/SessionHandle';
import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import { Runs } from '@agent/runtime/runRegistry';
import { platform } from '@platform/platform';
import { workspaceRoots } from '@platform/workspaceRoots';
import {
  AgentCategory,
  RUN_OUTCOME,
  aggregateId,
  emptyRunEndOutput,
  type RunId,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { createFakeWorkspaceRoots, fakePath } from '@test/support/FakePlatform';
import {
  fakeProcessServices,
  installPlatform,
} from '@test/support/setupPlatform';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { generateRunId } from '@utils/core';
import { StorageFS } from '@utils/files/storageFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { createTestLaunchContext } from './launchContextTestUtils';

const storageMocks = vi.hoisted(() => ({
  finalizeRun: vi.fn().mockResolvedValue({ ok: true }),
  /** Storage root each host-exit terminal write resolved, by run id. */
  settledUnder: new Map<string, string>(),
}));

vi.mock('@agent/storage', () => ({
  finalizeRun: storageMocks.finalizeRun,
}));

vi.mock('@agent/storage/runLifecycle', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/storage/runLifecycle')>();
  return {
    ...actual,
    finalizeRun: vi.fn(
      (
        session: ReturnType<typeof createTestSession>,
        input: { runId: string },
      ) =>
        Effect.sync(() => {
          storageMocks.settledUnder.set(input.runId, session.roots.storage);
          return { ok: true, outcome: 'cancelled' };
        }),
    ),
  };
});

describe('session isolation', () => {
  it('currentSession() resolves the active run context session, default otherwise', async () => {
    const sessionB = createTestSession();
    try {
      expect(currentSession()).toBe(defaultSession());
      const ctx = createRunContext({
        session: sessionB,
      });
      withRunContext(ctx, () => {
        expect(currentSession()).toBe(sessionB);
      });
      // Resolution falls back to the default session outside any run.
      expect(currentSession()).toBe(defaultSession());
    } finally {
      await Effect.runPromise(sessionB.dispose());
    }
  });

  it('two sessions in one process write under their own roots', async () => {
    const paperA = createFakeWorkspaceRoots({
      workspacePath: fakePath('papers/a'),
      storagePath: fakePath('storage/a'),
    });
    const paperB = createFakeWorkspaceRoots({
      workspacePath: fakePath('papers/b'),
      storagePath: fakePath('storage/b'),
    });
    const sessionA = createTestSession({ roots: paperA });
    const sessionB = createTestSession({ roots: paperB });
    try {
      await runInSession(sessionA, async () => {
        expect(WorkspaceFS.getPath()).toBe(fakePath('papers/a'));
        await StorageFS.ensureDir('.');
        await StorageFS.write('note.txt', 'from a');
      });
      await runInSession(sessionB, async () => {
        expect(WorkspaceFS.getPath()).toBe(fakePath('papers/b'));
        await StorageFS.ensureDir('.');
        await StorageFS.write('note.txt', 'from b');
      });
      const read = async (file: string) =>
        Buffer.from(await platform().fs.readFile(file)).toString('utf8');
      expect(await read(fakePath('storage/a/note.txt'))).toBe('from a');
      expect(await read(fakePath('storage/b/note.txt'))).toBe('from b');
      // Outside both scopes the process roots answer, not either paper.
      expect(workspaceRoots().workspace).toBe(fakePath('workspace'));
      expect(WorkspaceFS.getPath()).toBe(fakePath('workspace'));
      expect(workspaceRoots().storage).toBe(
        fakePath('workspace/.texra/storage'),
      );
    } finally {
      await Effect.runPromise(sessionA.dispose());
      await Effect.runPromise(sessionB.dispose());
    }
  });

  it.effect(
    'the host-exit drain settles each session under its own root, outside any scope',
    () =>
      Effect.gen(function* () {
        const sessionA = createTestSession({
          roots: createFakeWorkspaceRoots({
            workspacePath: fakePath('papers/a'),
            storagePath: fakePath('storage/a'),
          }),
        });
        yield* Effect.addFinalizer(() => sessionA.dispose());
        const sessionB = createTestSession({
          roots: createFakeWorkspaceRoots({
            workspacePath: fakePath('papers/b'),
            storagePath: fakePath('storage/b'),
          }),
        });
        yield* Effect.addFinalizer(() => sessionB.dispose());
        const live = [
          [sessionA, 'a0da01' as RunId],
          [sessionB, 'b0db01' as RunId],
        ] as const;
        const closures = live.map(([session]) =>
          vi.spyOn(session, 'publishRunEvent').mockImplementation(() => {}),
        );
        for (const [session, runId] of live) {
          publishTestRunStart(session, runId);
          session.publish([
            {
              type: 'stage.start',
              aggregateId: aggregateId('run', runId),
              id: `stage:${runId}`,
              label: 'Running stage',
            },
          ]);
          yield* session.settlePublications();
          session.runs.track(
            testRunHandle({
              runId,
              agent: 'assistant',
            }),
          );
          // The run's first append claimed its aggregate for this process.
          expect(yield* session.ownsRun(runId)).toBe(true);
        }
        // Each session claims runs in its own root: paper B never holds
        // paper A's run.
        expect(yield* sessionB.ownsRun('a0da01' as RunId)).toBe(false);
        yield* settleLiveSessionRuns(new AbortController().signal);
        for (const [index, [, runId]] of live.entries()) {
          expect(closures[index]).toHaveBeenCalledWith(runId, {
            type: 'stage.end',
            id: `stage:${runId}`,
            status: RUN_OUTCOME.CANCELLED,
          });
        }
        expect(storageMocks.settledUnder.get('a0da01')).toBe(
          fakePath('storage/a'),
        );
        expect(storageMocks.settledUnder.get('b0db01')).toBe(
          fakePath('storage/b'),
        );
        for (const [session, runId] of live) {
          expect(yield* session.ownsRun(runId)).toBe(false);
        }
      }),
  );

  it('a handle interrupt target lands in the run session only', async () => {
    const sessionB = createTestSession();
    const runId = generateRunId();
    const interrupt = vi.fn();
    try {
      const handle = testRunHandle({
        runId,
        agent: 'assistant',
      });
      handle.attachInterruptHandler({ interrupt });
      sessionB.runs.track(handle);

      const stop = sessionB.runs.kill(runId);
      expect(stop.accepted()).toBe(true);
      await Effect.runPromise(stop.settlement);
      expect(interrupt).toHaveBeenCalledOnce();
      expect(defaultSession().runs.getHandle(runId)).toBeUndefined();
    } finally {
      await Effect.runPromise(sessionB.dispose());
    }
  });

  it('runFlowWithLifecycle tracks the handle in the runs it is provided, not the default', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
    });
    const runId = 'e15001' as RunId;
    const sessionB = createTestSession();
    const ctx = createTestLaunchContext({
      runId,
      session: sessionB,
    });

    try {
      await Effect.runPromise(
        Effect.provide(
          runFlowWithLifecycle(ctx, () =>
            Effect.sync(() => {
              // Mid-run: the handle is registered in session B's registry only.
              expect(sessionB.runs.getHandle(runId)).toBeDefined();
              expect(defaultSession().runs.getHandle(runId)).toBeUndefined();
              return {
                outcome: RUN_OUTCOME.COMPLETED,
                runId,
                output: emptyRunEndOutput(AgentCategory.ToolUse),
              };
            }),
          ).pipe(Effect.provideService(Runs, sessionB.runs)),
          fakeProcessServices(),
        ),
      );

      // After completion the run session untracked it; default never saw it.
      expect(sessionB.runs.getHandle(runId)).toBeUndefined();
      expect(defaultSession().runs.getHandle(runId)).toBeUndefined();
    } finally {
      await Effect.runPromise(sessionB.dispose());
    }
  });
});
