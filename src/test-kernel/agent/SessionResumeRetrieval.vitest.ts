/**
 * The resume identity a host launches a resumed run with: whether its rows
 * say it can resume, and its configuration. The run's state is
 * `RunHistory.load`, folded by the loop that continues it: nothing here
 * carries a conversation, and no checkpoint file is parsed.
 */

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { positionRow } from '@agent/runtime/loop/rows';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  emptyRunEndOutput,
  storedRunOutput,
  type RunId,
} from '@shared/schemas';
import { DatabaseReadFailed } from '@shared/session/database';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

const CONFIG = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'openai/gpt-5.4-2026-03-05',
  instruction: 'Continue.',
  workingDirectory: '/workspace',
});
describe('retrieveSessionResumeData', () => {
  setupPlatform({ workspacePath: '/workspace' });

  let session: SessionHandle;
  beforeEach(async () => {
    session = await Effect.runPromise(createProcessSession());
  });

  /** Open the run aggregate the way a loop does: claim, then a position. */
  const openRun = Effect.fn('openRun')(function* (runId: RunId) {
    publishTestRunStart(session, runId);
    yield* session.log.settled;
    yield* session.runHistory.acquire(runId);
    yield* session.runHistory.appendBatch(runId, null, [
      positionRow(runId, { turn: 0 }, 'turn.ready'),
    ]);
  });

  it.effect('resumes an opened run on its configuration, under its id', () =>
    Effect.gen(function* () {
      const runId = 'abc123' as RunId;
      yield* openRun(runId);

      expect(yield* retrieveSessionResumeData(runId, CONFIG, session)).toEqual({
        runId,
        agentConfig: CONFIG,
      });
    }),
  );

  it.effect('reports an ended run never opened as nothing to resume', () =>
    Effect.gen(function* () {
      const runId = 'ab0002' as RunId;
      publishTestRunStart(session, runId);
      // Registered and never opened, it would resume by opening: it ended.
      yield* session.log.transact([
        {
          type: 'run.end',
          aggregateId: aggregateId('run', runId),
          outcome: 'failed',
          output: storedRunOutput(emptyRunEndOutput()),
        },
      ]);

      expect(
        yield* retrieveSessionResumeData(runId, CONFIG, session),
      ).toBeNull();
    }),
  );

  it.effect('throws when the durable run facts cannot be read', () =>
    Effect.gen(function* () {
      const runId = 'ab0005' as RunId;
      publishTestRunStart(session, runId);
      yield* session.log.settled;
      vi.spyOn(session.log, 'records').mockReturnValue(
        Effect.fail(
          new DatabaseReadFailed({
            path: 'session.db',
            cause: new Error('KV timeout'),
          }),
        ),
      );

      const error = yield* Effect.flip(
        retrieveSessionResumeData(runId, CONFIG, session),
      );
      expect(error.message).toContain(
        `Failed to retrieve resume data for run: ${runId}`,
      );
    }),
  );
});
