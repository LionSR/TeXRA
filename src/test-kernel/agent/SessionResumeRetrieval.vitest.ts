/**
 * The resume identity a host launches a resumed run with, read from the run
 * aggregate's latest `run.snapshot`. The run's state is `RunLedger.load`,
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
  type RunSnapshotPayload,
  type ModelCompatibilityKey,
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
  model: 'gpt54',
  instruction: 'Continue.',
  agentCategory: AgentCategory.ToolUse,
  workingDirectory: '/workspace',
});
const WORKFLOW_CONFIG: AgentConfig = {
  ...CONFIG,
  agentCategory: AgentCategory.Workflow,
};
const COMPATIBILITY_KEY: ModelCompatibilityKey = 'OpenAIResponse';

const runtimeOf = (
  modelId: string,
  compatibilityKey: ModelCompatibilityKey | null,
): RunSnapshotPayload['runtime'] => ({
  modelId,
  modelCompatibilityKey: compatibilityKey,
  lastError: null,
  declinedRoutes: [],
});

function toolUseSnapshot(
  modelId: string,
  compatibilityKey: ModelCompatibilityKey | null = COMPATIBILITY_KEY,
): RunSnapshotPayload {
  return {
    family: 'toolUse',
    runtime: runtimeOf(modelId, compatibilityKey),
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
    yield* session.ledger.acquire(runId);
    yield* session.ledger.appendBatch(runId, null, [
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
        yield* openRun(runId, toolUseSnapshot('gpt55'));

        expect(
          yield* retrieveSessionResumeData(runId, CONFIG, session),
        ).toMatchObject({
          runId,
          agentConfig: { model: 'gpt55' },
        });
      }),
  );

  it.effect('reports a run with no snapshot as nothing to resume', () =>
    Effect.gen(function* () {
      const runId = 'ab0002' as RunId;
      publishTestRunStart(session, runId);
      yield* session.settlePublications();

      expect(
        yield* retrieveSessionResumeData(runId, CONFIG, session),
      ).toBeNull();
    }),
  );

  it.effect('retrieves a workflow run on the same resume identity', () =>
    Effect.gen(function* () {
      const runId = 'ab0003' as RunId;
      yield* openRun(runId, toolUseSnapshot('gpt54'));

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
      vi.spyOn(session.ledger, 'latestSnapshot').mockReturnValue(
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
