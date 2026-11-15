import { Effect, Schema, SubscriptionRef, Context } from 'effect';
import { layer } from '@effect/vitest';
import { expect } from 'vitest';

import {
  RunIdSchema,
  AgentConfigSchema,
  qualifyAggregateId,
} from '@texra-ai/harness/schemas';
import { getRunRecords } from '@agent/storage/runOwnership';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { seedRunRecord } from '@test/support/runRecordSeeds';
import { runStart } from '@test/support/sessionRows';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';

const runId = Schema.decodeUnknownSync(RunIdSchema)('abcdef');

/** The run's report as child delivery commits it. */
const seedReport = (
  session: Context.Context<SessionServices>,
  report: string,
) =>
  Context.get(session, SessionLog)
    .transact([
      {
        type: 'run.report',
        aggregateId: qualifyAggregateId('run', runId),
        report,
      },
    ])
    .pipe(Effect.asVoid);

/** `body` over the test's session, with the run `runId` started on it. */
const withStartedSession = <A, E>(
  body: (
    session: Context.Context<SessionServices>,
  ) => Effect.Effect<A, E, SessionServices>,
) =>
  Effect.gen(function* () {
    const session = yield* isolatedTestSession();
    yield* Context.get(session, SessionLog).transact([
      runStart(runId, { identity: { kind: 'agent', agent: 'worker' } }),
    ]);
    return yield* body(session).pipe(Effect.provide(session));
  });

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'canonical run records',
  (it) => {
    it.layer(FakeHost.layer({ workspaceRoot: '/workspace' }), {
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
                model: 'openai/gpt-6.1-sol',
                instruction: 'private instruction',
              });
              yield* seedRunRecord(session, runId, config);
              yield* seedReport(session, 'private report');
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

      it.effect('hides all private records at deletion', () =>
        withStartedSession((session) =>
          Effect.gen(function* () {
            const records = getRunRecords(runId);
            yield* seedRunRecord(
              session,
              runId,
              Schema.decodeUnknownSync(AgentConfigSchema)({
                agent: 'worker',
                model: 'openai/gpt-6.1-sol',
              }),
            );
            yield* seedReport(session, 'retained report bytes');
            yield* Context.get(session, SessionLog).transact([
              {
                type: 'process.exit',
                aggregateId: qualifyAggregateId('run', runId),
                code: 0,
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
              exit: { code: 0, timedOut: false },
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
          }),
        ),
      );
    });
  },
);
