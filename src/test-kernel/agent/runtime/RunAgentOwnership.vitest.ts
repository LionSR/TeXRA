/**
 * A root launch's ownership of its run, over a real store on the
 * validation model: the launch is the run's one owner here, holds its claim
 * for the run's life and lets it go when the run ends.
 *
 * Failure modes:
 * - a second launch of a running run starts it twice;
 * - a run is born without the identity of the agent it runs, or keeps its
 *   claim after its launch ends;
 * - a launch whose opening is refused leaves a run or a claim;
 * - a run whose claim the store refuses after its opening goes on as if it
 *   held it, and the refusal is a warning nobody reads.
 */
import '@test/support/sessionGraphTestSetup';

import { it } from '@effect/vitest';
import { Effect, Fiber, Schema } from 'effect';
import { describe, expect } from 'vitest';

import type { RootLaunchOptions } from '@agent/runtime/rootLaunch';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withProcessServices } from '@platform/processRuntime';
import { AgentConfigSchema, type RunId } from '@shared/schemas';
import { openTestDefaultSession } from '@test/support/sessionEnd';
import {
  claimHolder,
  parkedAfter,
  sessionStoreFaults,
  storedRows,
  untilStored,
  REAL_RUN_TIMEOUT,
  validationHost,
} from '@test/support/storeFaults';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { generateRunId } from '@utils/core';

const CONFIG = Schema.decodeUnknownSync(AgentConfigSchema)({
  agent: 'assistant',
  model: 'openai/gpt-5.6-sol',
  instruction: 'One answer.',
});

/** A root launch of `config` as `runId` on the session. */
const launch = (
  session: SessionHandle,
  runId: RunId,
  options: RootLaunchOptions = {},
  config = CONFIG,
) =>
  withProcessServices(
    testRuntime(),
    session.runs.launch({ request: { config, runId }, options }),
  );

describe('root launch run ownership', { timeout: REAL_RUN_TIMEOUT }, () => {
  validationHost('texra-ownership-');

  it.live('refuses a second launch while the first is still running', () =>
    Effect.gen(function* () {
      const roots = testWorkspaceRoots();
      const session = yield* openTestDefaultSession({ roots });
      const runId = generateRunId();
      const first = yield* Effect.forkChild(launch(session, runId));
      yield* untilStored(roots.storage, parkedAfter(runId, 1, roots.storage));

      expect(yield* Effect.flip(launch(session, runId))).toMatchObject({
        message: `Run is already running: ${runId}`,
      });
      yield* session.runs.stop(runId, { reason: 'user' }).settlement;
      yield* Fiber.await(first);
      expect(
        storedRows(roots.storage).filter(
          (row) => row.run === runId && row.type === 'run.activate',
        ),
      ).toHaveLength(1);
    }),
  );

  it.live(
    'a launch whose opening is refused fails as itself and leaves no run or claim',
    () =>
      Effect.gen(function* () {
        const roots = testWorkspaceRoots();
        const session = yield* openTestDefaultSession({ roots });
        const runId = generateRunId();
        const faults = yield* sessionStoreFaults(roots.storage);
        yield* faults.failNext('appendAll', 'run.start');

        const error = yield* Effect.flip(launch(session, runId));
        expect(error.message).toContain('injected appendAll fault');
        expect(claimHolder(roots.storage, runId)).toBeNull();
        expect(
          storedRows(roots.storage).filter((row) => row.run === runId),
        ).toEqual([]);
      }),
  );

  it.live(
    'a run whose claim the store refuses after its opening ends failed, naming the refusal',
    () =>
      Effect.gen(function* () {
        const roots = testWorkspaceRoots();
        const session = yield* openTestDefaultSession({ roots });
        const runId = generateRunId();
        const faults = yield* sessionStoreFaults(roots.storage);
        // The opening's append claims the run; the hold the run takes on
        // its claim right after is the launch's first `acquireClaims`.
        yield* faults.failNext('acquireClaims');

        const error = yield* Effect.flip(launch(session, runId));
        expect(error.message).toContain('injected acquireClaims fault');
        const end = storedRows(roots.storage).findLast(
          (row) => row.run === runId && row.type === 'run.end',
        );
        expect(end && JSON.parse(end.data)).toMatchObject({
          outcome: 'failed',
          error: {
            message: expect.stringContaining('injected acquireClaims fault'),
          },
        });
      }),
  );
});
