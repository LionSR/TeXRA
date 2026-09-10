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
import {
  acquireFreshRunLease,
  ownsRunLease,
} from '@agent/storage/executionLease';
import { platform } from '@platform/platform';
import { workspaceRoots } from '@platform/workspaceRoots';
import {
  RUN_OUTCOME,
  aggregateId,
  type RunId,
  type StreamTabId,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';
import { clearStreamStatusForTest } from '@test/support/streamStatusTestUtils';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { StorageFS } from '@utils/files/storageFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { createTestLaunchContext } from './launchContextTestUtils';

const storageMocks = vi.hoisted(() => ({
  finalizeRun: vi.fn().mockResolvedValue({ ok: true }),
  /** Storage root each host-exit terminal write resolved, by execution id. */
  settledUnder: new Map<string, string>(),
}));

vi.mock('@agent/storage', () => ({
  finalizeRun: storageMocks.finalizeRun,
}));

vi.mock('@agent/storage/executionLifecycle', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/storage/executionLifecycle')>();
  return {
    ...actual,
    finalizeRun: vi.fn(
      (
        session: ReturnType<typeof createTestSession>,
        input: { executionId: string },
      ) =>
        Effect.sync(() => {
          storageMocks.settledUnder.set(
            input.executionId,
            session.roots.storage,
          );
          return { ok: true, outcome: 'cancelled' };
        }),
    ),
  };
});

describe('session isolation', () => {
  it('currentSession() resolves the active run context session, default otherwise', () => {
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
      sessionB.dispose();
    }
  });

  it('two sessions in one process write under their own roots', async () => {
    const paperA = createFakeWorkspaceRoots({
      workspacePath: '/papers/a',
      storagePath: '/storage/a',
    });
    const paperB = createFakeWorkspaceRoots({
      workspacePath: '/papers/b',
      storagePath: '/storage/b',
    });
    const sessionA = createTestSession({ roots: paperA });
    const sessionB = createTestSession({ roots: paperB });
    try {
      await runInSession(sessionA, async () => {
        expect(WorkspaceFS.getPath()).toBe('/papers/a');
        await StorageFS.ensureDir('.');
        await StorageFS.write('note.txt', 'from a');
      });
      await runInSession(sessionB, async () => {
        expect(WorkspaceFS.getPath()).toBe('/papers/b');
        await StorageFS.ensureDir('.');
        await StorageFS.write('note.txt', 'from b');
      });
      const read = async (file: string) =>
        Buffer.from(await platform().fs.readFile(file)).toString('utf8');
      expect(await read('/storage/a/note.txt')).toBe('from a');
      expect(await read('/storage/b/note.txt')).toBe('from b');
      // Outside both scopes the process roots answer, not either paper.
      expect(workspaceRoots().workspace).toBe('/workspace');
      expect(WorkspaceFS.getPath()).toBe('/workspace');
      expect(workspaceRoots().storage).toBe('/workspace/.texra/storage');
    } finally {
      sessionA.dispose();
      sessionB.dispose();
    }
  });

  it.effect(
    'the host-exit drain settles each session under its own root, outside any scope',
    () =>
      Effect.gen(function* () {
        const sessionA = createTestSession({
          roots: createFakeWorkspaceRoots({
            workspacePath: '/papers/a',
            storagePath: '/storage/a',
          }),
        });
        const sessionB = createTestSession({
          roots: createFakeWorkspaceRoots({
            workspacePath: '/papers/b',
            storagePath: '/storage/b',
          }),
        });
        const live = [
          [sessionA, 'a0da01' as RunId],
          [sessionB, 'b0db01' as RunId],
        ] as const;
        const closures = live.map(([session, executionId]) =>
          vi.spyOn(session, 'publishRunEvent').mockImplementation(() => {
            expect(runInSession(session, () => ownsRunLease(executionId))).toBe(
              true,
            );
          }),
        );
        try {
          for (const [session, executionId] of live) {
            const streamId = `stream:${executionId}` as StreamTabId;
            publishTestRunStart(session, streamId, executionId);
            session.publish([
              {
                type: 'stage.start',
                aggregateId: aggregateId('stream', streamId),
                id: `stage:${executionId}`,
                label: 'Running stage',
              },
            ]);
            yield* Effect.promise(() =>
              runInSession(session, async () => {
                await acquireFreshRunLease(executionId);
                session.executions.track(
                  testExecutionHandle({
                    executionId,
                    parentStreamId: `stream:${executionId}` as StreamTabId,
                    agent: 'assistant',
                  }),
                );
              }),
            );
          }
          // A quit handler runs in no session scope; the process roots answer
          // there, and neither paper's lease is keyed under them.
          expect(ownsRunLease('a0da01' as RunId)).toBe(false);
          yield* settleLiveSessionRuns(new AbortController().signal);
          for (const [index, [, executionId]] of live.entries()) {
            expect(closures[index]).toHaveBeenCalledWith(
              `stream:${executionId}`,
              {
                type: 'stage.end',
                id: `stage:${executionId}`,
                status: RUN_OUTCOME.CANCELLED,
              },
            );
          }
          expect(storageMocks.settledUnder.get('a0da01')).toBe('/storage/a');
          expect(storageMocks.settledUnder.get('b0db01')).toBe('/storage/b');
          for (const [session, executionId] of live) {
            expect(runInSession(session, () => ownsRunLease(executionId))).toBe(
              false,
            );
          }
        } finally {
          sessionA.dispose();
          sessionB.dispose();
        }
      }),
  );

  it.effect('a handle interrupt target lands in the run session only', () =>
    Effect.gen(function* () {
      const sessionB = createTestSession();
      const executionId = 'exec:iso-interrupt' as RunId;
      const streamId = 'stream:iso-interrupt' as StreamTabId;
      const interrupt = vi.fn();
      try {
        const handle = testExecutionHandle({
          executionId,
          parentStreamId: streamId,
          agent: 'assistant',
        });
        handle.attachInterruptHandler({ interrupt });
        sessionB.executions.track(handle);

        const stop = sessionB.executions.kill(executionId);
        expect(stop.accepted).toBe(true);
        yield* stop.settlement;
        expect(interrupt).toHaveBeenCalledOnce();
        expect(
          defaultSession().executions.getHandle(executionId),
        ).toBeUndefined();
      } finally {
        sessionB.dispose();
      }
    }),
  );

  it.effect(
    'runFlowWithLifecycle tracks the handle in the run session, not the default',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            globalState: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
          }),
        );
        const executionId = 'e15001' as RunId;
        const streamId = 'stream:iso-track' as StreamTabId;
        const sessionB = createTestSession();
        const ctx = createTestLaunchContext({
          executionId,
          streamId,
          session: sessionB,
        });

        try {
          yield* runFlowWithLifecycle(ctx, async () => {
            // Mid-run: the handle is registered in session B's registry only.
            expect(sessionB.executions.getHandle(executionId)).toBeDefined();
            expect(
              defaultSession().executions.getHandle(executionId),
            ).toBeUndefined();
            return {
              category: 'toolUse',
              outcome: RUN_OUTCOME.COMPLETED,
              executionId,
              streamId,
            };
          });

          // After completion the run session untracked it; default never saw it.
          expect(sessionB.executions.getHandle(executionId)).toBeUndefined();
          expect(
            defaultSession().executions.getHandle(executionId),
          ).toBeUndefined();
        } finally {
          clearStreamStatusForTest(sessionB.status, streamId);
          sessionB.dispose();
        }
      }),
  );
});
