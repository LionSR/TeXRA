/**
 * A root launch's ownership of its run, over a real store on the
 * validation model: the launch is the run's one owner here, holds its claim
 * for the run's life and lets it go when the run ends.
 *
 * Failure modes:
 * - a second launch of a running run starts it twice;
 * - a run is born without the identity of the agent it runs, or keeps its
 *   claim after its launch ends;
 * - a launch whose opening is refused leaves a run, a claim, or a failure
 *   nobody presents.
 */
import '@test/support/sessionGraphTestSetup';

import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { describe, expect } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { RootLaunchOptions } from '@agent/runtime/rootLaunch';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withProcessServices } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';
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

const CONFIG = AgentConfigSchema.parse({
  agent: 'assistant',
  model: 'gpt56',
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
      const stop = session.runs.stop(runId, { reason: 'user' });
      expect(stop.accepted()).toBe(true);
      yield* stop.settlement;
      yield* Fiber.await(first);
      expect(
        storedRows(roots.storage).filter(
          (row) => row.run === runId && row.type === 'run.activate',
        ),
      ).toHaveLength(1);
    }),
  );

  it.live(
    "a fresh run is born as its agent's and lets its claim go when the launch ends",
    () =>
      Effect.gen(function* () {
        const roots = testWorkspaceRoots();
        const session = yield* openTestDefaultSession({ roots });
        const runId = generateRunId();

        yield* launch(session, runId, { stopAfterCycle: true });

        const start = storedRows(roots.storage).find(
          (row) => row.run === runId,
        );
        expect(start?.type).toBe('run.start');
        expect(JSON.parse(start!.data)).toMatchObject({
          identity: { kind: 'agent', agent: 'assistant' },
        });
        expect(claimHolder(roots.storage, runId)).toBeNull();
      }),
  );

  it.live(
    'a launch whose opening is refused fails as itself, leaves no run or claim, and presents its failure',
    () =>
      Effect.gen(function* () {
        const roots = testWorkspaceRoots();
        const shown: unknown[] = [];
        const session = yield* openTestDefaultSession({
          roots,
          interactions: {
            emit: (event, payload) => {
              shown.push({ event, payload });
            },
          },
        });
        const runId = generateRunId();
        const faults = yield* sessionStoreFaults(roots.storage);
        yield* faults.failNext('appendAll', 'run.start');

        const error = yield* Effect.flip(launch(session, runId));
        expect(error.message).toContain('injected appendAll fault');
        expect(claimHolder(roots.storage, runId)).toBeNull();
        expect(
          storedRows(roots.storage).filter((row) => row.run === runId),
        ).toEqual([]);
        expect(shown).toContainEqual({
          event: 'requestShowError',
          payload: expect.objectContaining({
            message: expect.stringContaining('injected appendAll fault'),
          }),
        });
      }),
  );
});
