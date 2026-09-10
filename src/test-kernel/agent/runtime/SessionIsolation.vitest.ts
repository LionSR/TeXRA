import { Effect } from 'effect';
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

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
} from '@agent/storage/runLease';
import { platform } from '@platform/platform';
import { workspaceRoots } from '@platform/workspaceRoots';
import {
  RUN_OUTCOME,
  aggregateId,
  type RunId,
  type RunId,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';
import { clearRunStatusForTest } from '@test/support/runStatusTestUtils';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
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
          storageMocks.settledUnder.set(
            input.runId,
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

  it('the host-exit drain settles each session under its own root, outside any scope', async () => {
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
    const closures = live.map(([session, runId]) =>
      vi.spyOn(session, 'publishRunEvent').mockImplementation(() => {
        expect(
          runInSession(session, () => ownsRunLease(runId)),
        ).toBe(true);
      }),
    );
    try {
      for (const [session, runId] of live) {
        const runId = `stream:${runId}` as RunId;
        publishTestRunStart(session, runId, runId);
        session.publish([
          {
            type: 'stage.start',
            aggregateId: aggregateId('stream', runId),
            id: `stage:${runId}`,
            label: 'Running stage',
          },
        ]);
        await runInSession(session, async () => {
          await acquireFreshRunLease(runId);
          session.runs.track(
            testRunHandle({
              runId,
              parentRunId: `stream:${runId}` as RunId,
              agent: 'assistant',
            }),
          );
        });
      }
      // A quit handler runs in no session scope; the process roots answer
      // there, and neither paper's lease is keyed under them.
      expect(ownsRunLease('a0da01' as RunId)).toBe(false);
      await Effect.runPromise(
        settleLiveSessionRuns(new AbortController().signal),
      );
      for (const [index, [, runId]] of live.entries()) {
        expect(closures[index]).toHaveBeenCalledWith(`stream:${runId}`, {
          type: 'stage.end',
          id: `stage:${runId}`,
          status: RUN_OUTCOME.CANCELLED,
        });
      }
      expect(storageMocks.settledUnder.get('a0da01')).toBe('/storage/a');
      expect(storageMocks.settledUnder.get('b0db01')).toBe('/storage/b');
      for (const [session, runId] of live) {
        expect(
          runInSession(session, () => ownsRunLease(runId)),
        ).toBe(false);
      }
    } finally {
      sessionA.dispose();
      sessionB.dispose();
    }
  });

  it('a handle interrupt target lands in the run session only', async () => {
    const sessionB = createTestSession();
    const runId = 'exec:iso-interrupt' as RunId;
    const runId = 'stream:iso-interrupt' as RunId;
    const interrupt = vi.fn();
    try {
      const handle = testRunHandle({
        runId,
        parentRunId: runId,
        agent: 'assistant',
      });
      handle.attachInterruptHandler({ interrupt });
      sessionB.runs.track(handle);

      const stop = sessionB.runs.kill(runId);
      expect(stop.accepted).toBe(true);
      await Effect.runPromise(stop.settlement);
      expect(interrupt).toHaveBeenCalledOnce();
      expect(
        defaultSession().runs.getHandle(runId),
      ).toBeUndefined();
    } finally {
      sessionB.dispose();
    }
  });

  it('runFlowWithLifecycle tracks the handle in the run session, not the default', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
    });
    const runId = 'e15001' as RunId;
    const runId = 'stream:iso-track' as RunId;
    const sessionB = createTestSession();
    const ctx = createTestLaunchContext({
      runId,
      runId,
      session: sessionB,
    });

    try {
      await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () => {
          // Mid-run: the handle is registered in session B's registry only.
          expect(sessionB.runs.getHandle(runId)).toBeDefined();
          expect(
            defaultSession().runs.getHandle(runId),
          ).toBeUndefined();
          return {
            category: 'toolUse',
            outcome: RUN_OUTCOME.COMPLETED,
            runId,
            runId,
          };
        }),
      );

      // After completion the run session untracked it; default never saw it.
      expect(sessionB.runs.getHandle(runId)).toBeUndefined();
      expect(
        defaultSession().runs.getHandle(runId),
      ).toBeUndefined();
    } finally {
      clearRunStatusForTest(sessionB.status, runId);
      sessionB.dispose();
    }
  });
});
