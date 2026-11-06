import { Effect, Schema, SubscriptionRef, Context } from 'effect';
import { layer } from '@effect/vitest';
import { expect } from 'vitest';

import {
  RunIdSchema,
  AgentConfigSchema,
  qualifyAggregateId,
} from '@texra-ai/harness/schemas';
import { getRunRecords } from '@agent/storage/runRecords';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { seedRunRecord, seedReport } from '@test/support/runRecordSeeds';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';

const runId = Schema.decodeUnknownSync(RunIdSchema)('abcdef');

/** `body` over the test's session, with the run `runId` started on it. */
const withStartedSession = <A, E>(
  body: (
    session: Context.Context<SessionServices>,
  ) => Effect.Effect<A, E, SessionServices>,
) =>
  Effect.gen(function* () {
    const session = yield* isolatedTestSession();
    yield* Context.get(session, SessionLog).transact([
      {
        type: 'run.start',
        aggregateId: qualifyAggregateId('run', runId),
        identity: { kind: 'agent', agent: 'worker' },
        userFollowUpSupport: 'unsupported',
        parent: null,
        provenance: null,
      },
    ]);
    return yield* body(session).pipe(Effect.provide(session));
  });

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'canonical run records',
  (it) => {
    it.layer(FakeHost.layer({ workspacePath: '/workspace' }), {
      buildPerTest: true,
    })((it) => {
      it.effect(
        'preserves private values while display readers drain past their commits',
        () =>
          withStartedSession((session) =>
            Effect.gen(function* () {
              const records = getRunRecords(runId);
              const config = Schema.decodeUnknownSync(AgentConfigSchema)({
                agent: 'worker',
                instruction: 'private instruction',
              });
              yield* seedRunRecord(session, runId, config);
              yield* seedReport(session, runId, 'private report');
              expect(yield* records.readConfig()).toEqual(config);
              expect(yield* records.readReport()).toBe('private report');
              const visible = yield* Context.get(session, SessionLog).display(
                runId,
              );
              // The configuration is the run's one `run.config` display
              // row; the report stays private.
              expect(visible.map((event) => event.type)).toEqual([
                'run.start',
                'run.config',
              ]);
              expect(
                SubscriptionRef.getUnsafe(
                  Context.get(session, SessionViewAccess).ref,
                ).cursor,
              ).toBe(Context.get(session, SessionLog).now());
            }),
          ),
      );

      it.effect(
        'hides all private records at deletion while their rows await collection',
        () =>
          withStartedSession((session) =>
            Effect.gen(function* () {
              const records = getRunRecords(runId);
              yield* seedRunRecord(
                session,
                runId,
                Schema.decodeUnknownSync(AgentConfigSchema)({
                  agent: 'worker',
                }),
              );
              yield* seedReport(session, runId, 'retained report bytes');
              yield* Context.get(session, SessionLog).transact([
                {
                  type: 'process.exit',
                  aggregateId: qualifyAggregateId('run', runId),
                  code: 0,
                  signal: null,
                  timedOut: false,
                },
                {
                  type: 'run.end',
                  aggregateId: qualifyAggregateId('run', runId),
                  outcome: 'completed',
                  output: { response: 'done', files: [] },
                },
              ]);
              expect(yield* records.readReport()).toBe('retained report bytes');
              // The result is the terminal fact with the process's exit.
              expect(yield* records.readResult()).toEqual({
                outcome: 'completed',
                output: { response: 'done', files: [] },
                exit: { code: 0, signal: null, timedOut: false },
              });
              yield* Context.get(session, SessionLog).transact([
                {
                  type: 'run.removed',
                  aggregateId: qualifyAggregateId('run', runId),
                },
              ]);
              expect(
                yield* Effect.all([
                  records.exists(),
                  records.readRunRecord(),
                  records.readReport(),
                  records.readWorkspaceFiles(),
                  records.readResult(),
                ]),
              ).toEqual([false, null, null, [], null]);
              const retained = yield* Context.get(session, SessionLog).runRows(
                qualifyAggregateId('run', runId),
                'input',
              );
              expect(retained.removed).not.toBeNull();
            }),
          ),
      );
    });
  },
);
