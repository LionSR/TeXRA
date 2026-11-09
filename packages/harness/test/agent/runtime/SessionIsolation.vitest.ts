// Node imports
import { mkdirSync, writeFileSync } from 'node:fs';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Schema, Context, Deferred, Fiber } from 'effect';

import { expect } from 'vitest';
import { Sessions } from '@texra-ai/harness';
import {
  qualifyAggregateId,
  RUN_OUTCOME,
  RunIdSchema,
} from '@texra-ai/harness/schemas';
import { endRunRows } from '@agent/storage/runLifecycle';

import { registryOf, Runs } from '@agent/runtime/runRegistry';
import { ProjectEnvironment } from '@utils/system/nodeWorkspace';
import { SessionLog } from '@shared/session/runHistory';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { startAwaited } from '@test/support/runHandleFixtures';
import {
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'session isolation',
  (it) => {
    it.effect(
      'keeps one launch environment across opening and execution without refreshing management',
      () =>
        Effect.gen(function* () {
          // Failure modes: an edit during opening changes the executing
          // run's environment; management rereads a launch-only file.
          const host = yield* FakeHost;
          const workspace = host.path('launch-environment');
          const file = `${workspace}/.env`;
          // The production environment reader uses Node's synchronous I/O.
          yield* Effect.sync(() => {
            mkdirSync(workspace, { recursive: true });
            writeFileSync(file, 'TEXRA_TEST_LAUNCH_VALUE=opening\n');
          });
          const roots = createFakeWorkspaceRoots({
            workspaceRoot: workspace,
            storagePath: host.path('storage/launch-environment'),
          });
          const session = yield* Effect.flatMap(
            TestSession.open(roots),
            sessionHandleOf,
          );
          const runs = registryOf(Context.get(session, Runs));
          const runId = yield* publishTestRunStart(session);
          const observed = yield* Deferred.make<string | undefined>();
          const { opened, fiber } = yield* runs.start(runId, {
            open: Effect.gen(function* () {
              const environment = yield* ProjectEnvironment;
              yield* Effect.sync(() =>
                writeFileSync(file, 'TEXRA_TEST_LAUNCH_VALUE=changed\n'),
              );
              return environment.TEXRA_TEST_LAUNCH_VALUE;
            }),
            run: () =>
              Effect.gen(function* () {
                const environment = yield* ProjectEnvironment;
                yield* Deferred.succeed(
                  observed,
                  environment.TEXRA_TEST_LAUNCH_VALUE,
                );
                yield* Effect.never;
              }).pipe(
                Effect.onInterrupt(() =>
                  endRunRows({ runId, outcome: RUN_OUTCOME.CANCELLED }).pipe(
                    Effect.orDie,
                    Effect.provide(session),
                  ),
                ),
              ),
          });
          const executing = yield* Deferred.await(observed);
          const management = yield* runs.inSession(ProjectEnvironment);
          expect(yield* runs.stop(runId, 'user')).toBe(true);
          yield* Fiber.await(fiber);
          expect(opened).toBe('opening');
          expect(executing).toBe('opening');
          expect(management.TEXRA_TEST_LAUNCH_VALUE).toBeUndefined();
        }),
    );

    it.effect(
      'the host-exit drain settles each session under its own root, outside any scope',
      () =>
        Effect.gen(function* () {
          // Persistent stores, so each root's rows outlive its session's close
          // and are read back from the root they landed in.
          const host = yield* FakeHost;
          const rootsA = createFakeWorkspaceRoots({
            workspaceRoot: host.path('papers/a'),
            storagePath: host.path('storage/a'),
          });
          const rootsB = createFakeWorkspaceRoots({
            workspaceRoot: host.path('papers/b'),
            storagePath: host.path('storage/b'),
          });
          const sessions = yield* Sessions;
          const sessionA = yield* Effect.flatMap(
            TestSession.open(rootsA, { persistent: true }),
            sessionHandleOf,
          );
          const sessionB = yield* Effect.flatMap(
            TestSession.open(rootsB, { persistent: true }),
            sessionHandleOf,
          );
          const live = [
            [sessionA, Schema.decodeUnknownSync(RunIdSchema)('a0da01')],
            [sessionB, Schema.decodeUnknownSync(RunIdSchema)('b0db01')],
          ] as const;
          for (const [session, runId] of live) {
            yield* publishTestRunStart(session, runId);
            yield* publishTestRows(session, [
              {
                type: 'stage.start',
                aggregateId: qualifyAggregateId('run', runId),
                id: `stage:${runId}`,
                label: 'Running stage',
              },
            ]);
            yield* Context.get(session, SessionLog).settled;
            // A live run whose stop ends it, as its lifecycle's terminal does.
            yield* Effect.forkDetach(
              startAwaited(
                Context.get(session, Runs),
                runId,
                Effect.never.pipe(
                  Effect.onInterrupt(() =>
                    endRunRows({
                      runId,
                      outcome: RUN_OUTCOME.CANCELLED,
                    })
                      .pipe(Effect.orDie)
                      .pipe(Effect.provide(session)),
                  ),
                ),
              ),
              { startImmediately: true },
            );
          }
          yield* Effect.all([sessions.close(rootsA), sessions.close(rootsB)], {
            concurrency: 'unbounded',
          });
          // Each run's end landed in its own root's store, and only there.
          for (const [roots, own, other] of [
            [rootsA, 'a0da01', 'b0db01'],
            [rootsB, 'b0db01', 'a0da01'],
          ] as const) {
            const reopened = yield* Effect.flatMap(
              TestSession.open(roots, { persistent: true }),
              sessionHandleOf,
            );
            const ends = (runId: string) =>
              Effect.map(
                Context.get(reopened, SessionLog).runRows(
                  qualifyAggregateId(
                    'run',
                    Schema.decodeUnknownSync(RunIdSchema)(runId),
                  ),
                  'lifecycle',
                ),
                (rows) =>
                  rows.lifecycles.filter((row) => row.type === 'run.end'),
              );
            expect(yield* ends(own)).toMatchObject([
              { outcome: RUN_OUTCOME.CANCELLED },
            ]);
            expect(yield* ends(other)).toEqual([]);
            yield* sessions.close(roots);
          }
        }),
    );
  },
);
