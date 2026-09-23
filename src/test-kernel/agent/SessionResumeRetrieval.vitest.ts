/**
 * The resume identity a host launches a resumed run with, read from the run
 * aggregate's latest `flow.snapshot`. The run's state is `RunLedger.load`,
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
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  AgentCategory,
  type FlowSnapshotPayload,
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
): Extract<FlowSnapshotPayload, { family: 'toolUse' }>['runtime'] => ({
  phase: 'initial',
  round: 0,
  turn: 0,
  continuationIndex: 0,
  modelId,
  modelCompatibilityKey: compatibilityKey,
  lastError: null,
  declinedRoutes: [],
});

function toolUseSnapshot(
  modelId: string,
  compatibilityKey: ModelCompatibilityKey | null = COMPATIBILITY_KEY,
): FlowSnapshotPayload {
  return {
    family: 'toolUse',
    runtime: runtimeOf(modelId, compatibilityKey),
    state: { stateSlices: null },
  };
}

function reflectionSnapshot(modelId: string): FlowSnapshotPayload {
  return {
    family: 'reflection',
    runtime: runtimeOf(modelId, COMPATIBILITY_KEY),
    state: {
      totalRounds: 2,
      workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
    },
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
    payload: FlowSnapshotPayload,
  ) {
    publishTestRunStart(session, runId);
    yield* session.settlePublications();
    yield* session.ledger.acquire(runId);
    yield* session.ledger.appendBatch(runId, null, [
      {
        type: 'flow.snapshot',
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
          type: 'toolUse',
          runId,
          agentConfig: { model: 'gpt55' },
          modelCompatibilityKey: COMPATIBILITY_KEY,
        });
      }),
  );

  it.effect('resumes an untagged conversation format as untagged', () =>
    Effect.gen(function* () {
      const runId = 'ab0001' as RunId;
      yield* openRun(runId, toolUseSnapshot('gpt54', null));

      expect(
        yield* retrieveSessionResumeData(runId, CONFIG, session),
      ).toMatchObject({ modelCompatibilityKey: null });
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

  it.effect('retrieves a workflow run from its reflection snapshot', () =>
    Effect.gen(function* () {
      const runId = 'ab0003' as RunId;
      yield* openRun(runId, reflectionSnapshot('gpt54'));

      expect(
        yield* retrieveSessionResumeData(runId, WORKFLOW_CONFIG, session),
      ).toMatchObject({ type: 'workflow', runId });
    }),
  );

  // A family the launch config contradicts is corruption, never a silent
  // "nothing to resume": the caller must be able to tell the two apart.
  it.effect('refuses a tool-use launch onto a reflection run', () =>
    Effect.gen(function* () {
      const runId = 'ab0004' as RunId;
      yield* openRun(runId, reflectionSnapshot('gpt54'));

      const error = yield* Effect.flip(
        retrieveSessionResumeData(runId, CONFIG, session),
      );
      expect(error.message).toContain(
        `Run ${runId} is configured as toolUse but its snapshot is a reflection run.`,
      );
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
