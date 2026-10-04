/**
 * The resume identity a host launches a resumed run with, read from the run
 * aggregate's latest `run.snapshot`. The run's state is `RunHistory.load`,
 * folded by the loop that continues it: nothing here carries a conversation,
 * and no checkpoint file is parsed.
 */

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  AgentCategory,
  emptyRunEndOutput,
  storedRunOutput,
  type RunSnapshotPayload,
  type ModelBackend,
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
  agentCategory: AgentCategory.ToolUse,
  workingDirectory: '/workspace',
});
const WORKFLOW_CONFIG: AgentConfig = {
  ...CONFIG,
  agentCategory: AgentCategory.Workflow,
};
const BACKEND: ModelBackend = 'openai';

const runtimeOf = (
  modelId: string,
  backend: ModelBackend,
): RunSnapshotPayload['runtime'] => ({
  modelId,
  backend,
  lastError: null,
  declinedRoutes: [],
});

function toolUseSnapshot(
  modelId: string,
  backend: ModelBackend = BACKEND,
): RunSnapshotPayload {
  return {
    family: 'toolUse',
    runtime: runtimeOf(modelId, backend),
    state: { stateSlices: null },
  };
}

describe('retrieveSessionResumeData', () => {
  setupPlatform({ workspacePath: '/workspace' });

  let session: SessionHandle;
  beforeEach(async () => {
    session = await Effect.runPromise(createProcessSession());
  });

  /** Open the run aggregate the way a loop does: claim, then snapshot. */
  const openRun = Effect.fn('openRun')(function* (
    runId: RunId,
    payload: RunSnapshotPayload,
  ) {
    publishTestRunStart(session, runId);
    yield* session.settlePublications();
    yield* session.runHistory.acquire(runId);
    yield* session.runHistory.appendBatch(runId, null, [
      {
        type: 'run.snapshot',
        aggregateId: aggregateId('run', runId),
        payload,
      },
    ]);
  });

  it.effect(
    'resumes on the model the snapshot names, under the original run id',
    () =>
      Effect.gen(function* () {
        const runId = 'abc123' as RunId;
        yield* openRun(runId, toolUseSnapshot('openai/gpt-5.5-2026-04-23'));

        expect(
          yield* retrieveSessionResumeData(runId, CONFIG, session),
        ).toMatchObject({
          runId,
          agentConfig: { model: 'openai/gpt-5.5-2026-04-23' },
        });
      }),
  );

  it.effect('reports an ended run with no snapshot as nothing to resume', () =>
    Effect.gen(function* () {
      const runId = 'ab0002' as RunId;
      publishTestRunStart(session, runId);
      // Registered and never opened, it would resume by opening: it ended.
      yield* session.commit([
        {
          type: 'run.end',
          aggregateId: aggregateId('run', runId),
          outcome: 'failed',
          output: storedRunOutput(emptyRunEndOutput(AgentCategory.ToolUse)),
        },
      ]);

      expect(
        yield* retrieveSessionResumeData(runId, CONFIG, session),
      ).toBeNull();
    }),
  );

  it.effect('retrieves a workflow run on the same resume identity', () =>
    Effect.gen(function* () {
      const runId = 'ab0003' as RunId;
      yield* openRun(runId, toolUseSnapshot('openai/gpt-5.4-2026-03-05'));

      expect(
        yield* retrieveSessionResumeData(runId, WORKFLOW_CONFIG, session),
      ).toMatchObject({ runId, agentConfig: { agentCategory: 'workflow' } });
    }),
  );

  it.effect('throws when the durable run facts cannot be read', () =>
    Effect.gen(function* () {
      const runId = 'ab0005' as RunId;
      publishTestRunStart(session, runId);
      yield* session.settlePublications();
      vi.spyOn(session.runHistory, 'latestSnapshot').mockReturnValue(
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
        `Failed to retrieve toolUse resume data for run: ${runId}`,
      );
    }),
  );
});
