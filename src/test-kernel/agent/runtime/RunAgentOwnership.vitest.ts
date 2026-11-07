/**
 * A root launch's hold on its run, over a real store on the validation
 * model: the launch is the run's one launch here for the run's life.
 *
 * Failure modes:
 * - a second launch of a running run starts it twice;
 * - a run is born without the identity of the agent it runs;
 * - a launch whose opening is refused leaves a run.
 */
import { layer } from '@effect/vitest';
import { Effect, Fiber, Schema, Context } from 'effect';
import { describe, expect } from 'vitest';

import {
  AgentConfigSchema,
  generateRunId,
  type RunId,
} from '@texra-ai/harness/schemas';
import { rootRun, type SessionServices } from '@agent/runtime/rootLaunch';
import { Runs } from '@agent/runtime/runRegistry';
import {
  parkedAfter,
  persistentTestSession,
  sessionStoreFaults,
  storedRows,
  untilStored,
  REAL_RUN_TIMEOUT,
  validationHost,
} from '@test/support/storeFaults';
import { FakeHost } from '@test/support/testKernel';
import { TEXRA_APP, texraHosted } from '@test/support/texraApp';

const CONFIG = Schema.decodeUnknownSync(AgentConfigSchema)({
  agent: 'assistant',
  model: 'openai/gpt-5.6-sol',
  instruction: 'One answer.',
});

/** A root launch of `config` as `runId` on the session. */
const launch = (session: Context.Context<SessionServices>, runId: RunId) =>
  rootRun({ config: CONFIG, runId, interactive: true }).pipe(
    Effect.provide(session),
  );

describe('root launch run ownership', { timeout: REAL_RUN_TIMEOUT }, () => {
  layer(texraHosted, { excludeTestServices: true })((it) => {
    it.layer(validationHost('texra-ownership-', TEXRA_APP), {
      buildPerTest: true,
    })((it) => {
      it.effect(
        'refuses a second launch while the first is still running',
        () =>
          Effect.gen(function* () {
            const { roots } = yield* FakeHost;
            const session = yield* persistentTestSession();
            const runId = generateRunId();
            const first = yield* Effect.forkChild(launch(session, runId));
            yield* untilStored(
              roots.storage,
              parkedAfter(runId, 1, roots.storage),
            );

            expect(yield* Effect.flip(launch(session, runId))).toMatchObject({
              message: `Run is already running: ${runId}`,
            });
            yield* Context.get(session, Runs).stop(runId, 'user');
            yield* Fiber.await(first);
            expect(
              storedRows(roots.storage).filter(
                (row) => row.run === runId && row.type === 'run.activate',
              ),
            ).toHaveLength(1);
          }),
      );

      it.effect(
        'a launch whose opening is refused fails as itself and leaves no run',
        () =>
          Effect.gen(function* () {
            const { roots } = yield* FakeHost;
            const session = yield* persistentTestSession();
            const runId = generateRunId();
            const faults = yield* sessionStoreFaults(roots.storage);
            yield* faults.failNext('appendAll', 'run.start');

            const error = yield* Effect.flip(launch(session, runId));
            expect(error.message).toContain('injected appendAll fault');
            expect(
              storedRows(roots.storage).filter((row) => row.run === runId),
            ).toEqual([]);
          }),
      );
    });
  });
});
