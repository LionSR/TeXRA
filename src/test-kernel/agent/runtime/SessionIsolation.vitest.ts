import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';

import { describe, expect, vi } from 'vitest';

import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import { Runs } from '@agent/runtime/runRegistry';
import {
  AgentCategory,
  RUN_OUTCOME,
  aggregateId,
  emptyRunEndOutput,
  type RunId,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { closeSessionOf } from '@test/support/sessionEnd';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { createFakeWorkspaceRoots, fakePath } from '@test/support/FakePlatform';
import {
  fakeProcessServices,
  installPlatform,
} from '@test/support/setupPlatform';
import {
  admitInterruptibleRun,
  testRunHandle,
} from '@test/support/runHandleFixtures';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { generateRunId } from '@utils/core';
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
  it.effect('two sessions in one process write under their own roots', () =>
    Effect.gen(function* () {
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
      yield* Effect.addFinalizer(() =>
        closeSessionOf(sessionA).pipe(Effect.andThen(closeSessionOf(sessionB))),
      );
      // The notes are real files under the fake roots, so the fs calls stay
      // foreign promises bridged with Effect.promise.
      const writeNote = (session: typeof sessionA, note: string) =>
        Effect.promise(async () => {
          await mkdir(session.roots.storage, { recursive: true });
          await writeFile(path.join(session.roots.storage, 'note.txt'), note);
        });
      expect(sessionA.roots.workspace).toBe(fakePath('papers/a'));
      yield* writeNote(sessionA, 'from a');
      expect(sessionB.roots.workspace).toBe(fakePath('papers/b'));
      yield* writeNote(sessionB, 'from b');
      const read = (file: string) =>
        Effect.promise((): Promise<string> => readFile(file, 'utf8'));
      expect(yield* read(fakePath('storage/a/note.txt'))).toBe('from a');
      expect(yield* read(fakePath('storage/b/note.txt'))).toBe('from b');
      // Neither paper's roots are the process's: a session answers from the
      // record it holds, and the process roots name only the default session.
      expect(testWorkspaceRoots().workspace).toBe(fakePath('workspace'));
      expect(testWorkspaceRoots().storage).toBe(
        fakePath('workspace/.texra/storage'),
      );
    }),
  );

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
        yield* Effect.addFinalizer(() => closeSessionOf(sessionA));
        const sessionB = createTestSession({
          roots: createFakeWorkspaceRoots({
            workspacePath: fakePath('papers/b'),
            storagePath: fakePath('storage/b'),
          }),
        });
        yield* Effect.addFinalizer(() => closeSessionOf(sessionB));
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
        yield* Effect.all(
          [closeSessionOf(sessionA), closeSessionOf(sessionB)],
          {
            concurrency: 'unbounded',
          },
        );
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
      }),
  );

  /**
   * #12433, and the reason #12421 retired the carrier. This contract is the
   * one the desktop needs — two open projects, each its own session, its own
   * storage root — and an async-local frame could never meet it: a run fiber
   * resuming after a contended commit resumed outside the frame and read the
   * PROCESS roots. Roots arrive as data now, so the fiber's answer cannot
   * depend on which turn it resumes in. The case was `.fails` until the
   * carrier went; it is green from here.
   */
  it.effect(
    'a run fiber keeps its session roots across a contended publisher commit',
    () =>
      Effect.gen(function* () {
        const project = createFakeWorkspaceRoots({
          workspacePath: fakePath('papers/contended'),
          storagePath: fakePath('storage/contended'),
        });
        const session = createTestSession({ roots: project });
        yield* Effect.addFinalizer(() => closeSessionOf(session));
        // Job 1: enqueued on the session's one publisher from the process
        // context, the shape the desktop has.
        publishTestRunStart(session, 'c0c001' as RunId);
        // Job 2: the run fiber's own awaited commit, enqueued in the same
        // synchronous turn, so the publisher is already contended when it runs.
        const seen = yield* Effect.gen(function* () {
          yield* session.commit([
            {
              type: 'run.start',
              aggregateId: aggregateId('run', 'c0c002' as RunId),
              identity: { kind: 'agent', agent: 'chat' },
              userFollowUpSupport: 'unsupported',
              category: 'toolUse',
              isRemote: false,
              parent: null,
            },
          ]);
          return {
            workspace: session.roots.workspace,
            storage: session.roots.storage,
          };
        });
        expect(seen.workspace).toBe(fakePath('papers/contended'));
        expect(seen.storage).toBe(fakePath('storage/contended'));
      }),
  );

  it.effect('a run stop lands in the run session only', () =>
    Effect.gen(function* () {
      const sessionB = createTestSession();
      yield* Effect.addFinalizer(() => closeSessionOf(sessionB));
      const runId = generateRunId();
      const interrupt = vi.fn();
      const handle = testRunHandle({
        runId,
        agent: 'assistant',
      });
      sessionB.runs.track(handle);
      admitInterruptibleRun(sessionB.runs, runId, interrupt);

      const stop = sessionB.runs.stop(runId);
      expect(stop.accepted()).toBe(true);
      yield* stop.settlement;
      expect(interrupt).toHaveBeenCalledOnce();
      expect(testDefaultSession().runs.getHandle(runId)).toBeUndefined();
    }),
  );

  it.effect(
    'runFlowWithLifecycle tracks the handle in the runs it is provided, not the default',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            globalState: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
          }),
        );
        const runId = 'e15001' as RunId;
        const sessionB = createTestSession();
        yield* Effect.addFinalizer(() => closeSessionOf(sessionB));
        const ctx = createTestLaunchContext({
          runId,
          session: sessionB,
        });

        yield* Effect.provide(
          runFlowWithLifecycle(ctx, () =>
            Effect.sync(() => {
              // Mid-run: the handle is registered in session B's registry only.
              expect(sessionB.runs.getHandle(runId)).toBeDefined();
              expect(
                testDefaultSession().runs.getHandle(runId),
              ).toBeUndefined();
              return {
                outcome: RUN_OUTCOME.COMPLETED,
                runId,
                output: emptyRunEndOutput(AgentCategory.ToolUse),
              };
            }),
          ).pipe(Effect.provideService(Runs, sessionB.runs)),
          fakeProcessServices(),
        );

        // After completion the run session untracked it; default never saw it.
        expect(sessionB.runs.getHandle(runId)).toBeUndefined();
        expect(testDefaultSession().runs.getHandle(runId)).toBeUndefined();
      }),
  );
});
