import { layer } from '@effect/vitest';
import { Effect, Schema, Context } from 'effect';
import { expect, vi } from 'vitest';

import { DatabaseReadFailed } from '@texra-ai/harness';
import {
  type AgentConfig,
  AgentConfigSchema,
  qualifyAggregateId,
  type RunId,
  type RunIdentity,
} from '@texra-ai/harness/schemas';
import { listRuns } from '@agent/storage/runListing';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionLog } from '@shared/session/runHistory';
import { seedRunRecord } from '@test/support/runRecordSeeds';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

function config(agent: string): AgentConfig {
  return Schema.decodeUnknownSync(AgentConfigSchema)({
    agent,
    model: 'deepseek/deepseek-v4-flash',
    instruction: 'Test run listing.',
    workingDirectory: '/workspace',
  });
}

type Session = Context.Context<SessionServices>;

/** The test's session over the process roots. */
const processSession = Effect.flatMap(TestSession.open(), sessionHandleOf);

/** Commit the run's `run.start`, the fact its listing row is built from. */
const startRun = (
  session: Session,
  id: RunId,
  identity: RunIdentity,
  parentRunId?: RunId,
) =>
  Context.get(session, SessionLog).transact([
    {
      type: 'run.start',
      aggregateId: qualifyAggregateId('run', id),
      identity,
      userFollowUpSupport: 'unsupported',
      parent:
        parentRunId === undefined ? null : { id: parentRunId, call: null },
      provenance: null,
    },
  ]);

/** An agent run: its start and its configuration record. */
const writeRun = (
  session: Session,
  id: RunId,
  agent: string,
  parentRunId?: RunId,
) =>
  Effect.andThen(
    startRun(session, id, { kind: 'agent', agent }, parentRunId),
    seedRunRecord(session, id, config(agent)),
  );

layer(SessionGraph.layer, { excludeTestServices: true })(
  'run listing normalization',
  (it) => {
    it.layer(FakeHost.layer({ workspacePath: '/workspace' }), {
      buildPerTest: true,
    })((it) => {
      // A row is dropped only when the facts it is built from are
      // unreadable. The resumability read is not one of them: it decides an
      // advertisement, so an unreadable run record costs the row its Resume
      // affordance, never its place in history.
      it.effect(
        'keeps a row whose resumability read fails, not resumable',
        () =>
          Effect.gen(function* () {
            const session = yield* processSession;
            const id = 'eee556' as RunId;
            yield* writeRun(session, id, 'assistant');
            vi.spyOn(
              session.pipe(Context.get(SessionLog)),
              'facts',
            ).mockReturnValue(
              Effect.fail(
                new DatabaseReadFailed({
                  path: 'session.db',
                  cause: new Error('record read failed'),
                }),
              ),
            );

            expect(yield* listRuns().pipe(Effect.provide(session))).toEqual([
              expect.objectContaining({
                id,
                resumable: false,
              }),
            ]);
          }),
      );

      it.effect('lists agent runs only, not process storage rows', () =>
        Effect.gen(function* () {
          const session = yield* processSession;
          const processId = 'bbb222' as RunId;
          const customBashAgentId = 'ccc333' as RunId;
          yield* startRun(session, processId, {
            kind: 'process',
            tool: 'assistant',
          });
          yield* seedRunRecord(session, processId, config('assistant'));
          yield* writeRun(session, customBashAgentId, 'bash');

          expect(yield* listRuns().pipe(Effect.provide(session))).toEqual([
            expect.objectContaining({
              id: customBashAgentId,
              identity: { kind: 'agent', agent: 'bash' },
              record: expect.objectContaining({ agent: 'bash' }),
            }),
          ]);
        }),
      );

      it.effect('keeps agent-spawned child runs out of history listings', () =>
        Effect.gen(function* () {
          const session = yield* processSession;
          const rootId = 'eee111' as RunId;
          const childId = 'fff222' as RunId;
          yield* writeRun(session, rootId, 'orchestrator');
          yield* writeRun(session, childId, 'search', rootId);

          // A child belongs to its parent's transcript, not to the history
          // list.
          expect(
            (yield* listRuns().pipe(Effect.provide(session))).map(
              ({ id }) => id,
            ),
          ).toEqual([rootId]);
        }),
      );
    });
  },
);
