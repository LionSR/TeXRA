/**
 * The resume identity a host launches a resumed run with, read from the run
 * aggregate's latest `flow.snapshot`. The run's state is `RunLedger.load`,
 * folded by the loop that continues it: nothing here carries a conversation,
 * and no checkpoint file is parsed.
 */

import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  type ModelHandlerCompatibilityKey,
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
const COMPATIBILITY_KEY: ModelHandlerCompatibilityKey =
  'ModelHandlerOpenAIResponse';

const runtimeOf = (
  modelId: string,
  compatibilityKey: ModelHandlerCompatibilityKey | null,
): Extract<FlowSnapshotPayload, { family: 'toolUse' }>['runtime'] => ({
  phase: 'initial',
  round: 0,
  turn: 0,
  continuationIndex: 0,
  modelId,
  modelHandlerCompatibilityKey: compatibilityKey,
  lastError: null,
  pendingRetry: null,
});

const references = { pendingIntents: [], pendingResponse: null } as const;

function toolUseSnapshot(
  modelId: string,
  compatibilityKey: ModelHandlerCompatibilityKey | null = COMPATIBILITY_KEY,
): FlowSnapshotPayload {
  return {
    family: 'toolUse',
    runtime: runtimeOf(modelId, compatibilityKey),
    references,
    state: { shouldSkipCycle: false, stateSlices: null },
  };
}

function reflectionSnapshot(modelId: string): FlowSnapshotPayload {
  return {
    family: 'reflection',
    runtime: runtimeOf(modelId, COMPATIBILITY_KEY),
    references,
    state: {
      currentRound: 1,
      totalRounds: 2,
      workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
      outputLocation: null,
      runStateSnapshot: { totalRounds: 2, totalResponseTimeMs: 0 },
      roundOutputs: [],
      continueRounds: true,
      endTurn: false,
    },
  };
}

describe('retrieveSessionResumeData', () => {
  setupPlatform({ workspacePath: '/workspace' });

  let session: SessionHandle;
  beforeEach(() => {
    session = createProcessSession();
  });

  /** Open the run aggregate the way a loop does: claim, then snapshot. */
  async function openRun(
    runId: RunId,
    payload: FlowSnapshotPayload,
  ): Promise<void> {
    publishTestRunStart(session, runId);
    await session.settlePublications();
    await Effect.runPromise(session.ledger.acquire(runId));
    await Effect.runPromise(
      session.ledger.appendBatch(runId, null, [
        {
          type: 'flow.snapshot',
          aggregateId: aggregateId('run', runId),
          payload,
        },
      ]),
    );
  }

  it('resumes on the model the snapshot names, under the original run id', async () => {
    const runId = 'abc123' as RunId;
    await openRun(runId, toolUseSnapshot('gpt55'));

    await expect(
      Effect.runPromise(retrieveSessionResumeData(runId, CONFIG, session)),
    ).resolves.toMatchObject({
      type: 'toolUse',
      runId,
      agentConfig: { model: 'gpt55' },
      modelHandlerCompatibilityKey: COMPATIBILITY_KEY,
    });
  });

  it('resumes an untagged conversation format as untagged', async () => {
    const runId = 'ab0001' as RunId;
    await openRun(runId, toolUseSnapshot('gpt54', null));

    await expect(
      Effect.runPromise(retrieveSessionResumeData(runId, CONFIG, session)),
    ).resolves.toMatchObject({ modelHandlerCompatibilityKey: null });
  });

  it('reports a run with no snapshot as nothing to resume', async () => {
    const runId = 'ab0002' as RunId;
    publishTestRunStart(session, runId);
    await session.settlePublications();

    await expect(
      Effect.runPromise(retrieveSessionResumeData(runId, CONFIG, session)),
    ).resolves.toBeNull();
  });

  it('retrieves a workflow run from its reflection snapshot', async () => {
    const runId = 'ab0003' as RunId;
    await openRun(runId, reflectionSnapshot('gpt54'));

    await expect(
      Effect.runPromise(
        retrieveSessionResumeData(runId, WORKFLOW_CONFIG, session),
      ),
    ).resolves.toMatchObject({ type: 'workflow', runId });
  });

  // A family the launch config contradicts is corruption, never a silent
  // "nothing to resume": the caller must be able to tell the two apart.
  it('refuses a tool-use launch onto a reflection run', async () => {
    const runId = 'ab0004' as RunId;
    await openRun(runId, reflectionSnapshot('gpt54'));

    await expect(
      Effect.runPromise(retrieveSessionResumeData(runId, CONFIG, session)),
    ).rejects.toThrow(
      `Run ${runId} is configured as toolUse but its snapshot is a reflection run.`,
    );
  });

  it('throws when the durable run facts cannot be read', async () => {
    const runId = 'ab0005' as RunId;
    publishTestRunStart(session, runId);
    await session.settlePublications();
    vi.spyOn(session.ledger, 'latestSnapshot').mockReturnValue(
      Effect.fail(
        new DatabaseReadFailed({
          path: 'session.db',
          cause: new Error('KV timeout'),
        }),
      ),
    );

    await expect(
      Effect.runPromise(retrieveSessionResumeData(runId, CONFIG, session)),
    ).rejects.toThrow(
      `Failed to retrieve toolUse resume data for run: ${runId}`,
    );
  });
});
