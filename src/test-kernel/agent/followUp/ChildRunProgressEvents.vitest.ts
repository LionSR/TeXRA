// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Schema, Context } from 'effect';
import { expect } from 'vitest';

// Local imports
import {
  RunIdSchema,
  AgentConfigSchema,
  type RunId,
} from '@texra-ai/harness/schemas';
import { getRunRecords } from '@agent/storage/runRecords';
import { Runs } from '@agent/runtime/runRegistry';
import { launchProcessChild } from '@agent/runtime/delegation/detachedChildRun';
import { SessionLog } from '@shared/session/runHistory';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

const parentRunId = Schema.decodeUnknownSync(RunIdSchema)('c11112');
const config = Schema.decodeUnknownSync(AgentConfigSchema)({
  model: 'test-model',
  agent: 'test-agent',
});

/** The test's session over the process roots, with the parent run
 *  started on it. */
const parentSession = Effect.gen(function* () {
  const session = yield* Effect.flatMap(TestSession.open(), sessionHandleOf);
  publishTestRunStart(session, parentRunId);
  yield* Context.get(session, SessionLog).settled;
  return session;
});

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'child run progress events',
  (it) => {
    it.effect(
      'finalizes a child run when agent CLI loop setup fails synchronously',
      () =>
        Effect.gen(function* () {
          const setupError = new Error('child loop setup failed');
          const session = yield* parentSession;
          let childRunId: RunId | undefined;
          let visibleBeforeLoop = true;

          // The launch dies with the loop's throw, so flip the defect back
          // into the error channel.
          const defect = yield* Effect.flip(
            launchProcessChild(parentRunId, {
              identity: { kind: 'agent', agent: 'codex', tool: 'codex' },
              description: 'Fail during synchronous loop setup',
              config,
              buildLaunch: (context) => {
                childRunId = context.runId;
                // Before the loop reserves its stop target, no stop can find
                // the run: a stop never reaches a run it cannot interrupt.
                visibleBeforeLoop =
                  Context.get(session, Runs).get(context.runId) !== undefined;
                throw setupError;
              },
            })
              .pipe(
                Effect.provideService(Runs, Context.get(session, Runs)),
                Effect.catchDefect((cause) => Effect.fail(cause)),
              )
              .pipe(Effect.provide(session)),
          );
          expect(defect).toBe(setupError);
          expect(visibleBeforeLoop).toBe(false);
          if (!childRunId) throw new Error('the child launch was never built');
          expect(
            yield* getRunRecords(childRunId)
              .readRunEnd()
              .pipe(Effect.provide(session)),
          ).toMatchObject({ outcome: 'failed' });
        }),
    );
  },
);
