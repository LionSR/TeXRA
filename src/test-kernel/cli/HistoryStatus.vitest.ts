import '@test/support/sessionGraphTestSetup';
import { beforeEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import { registerRun, getRunStore } from '@agent/storage';
import { releaseOwnedRunLease } from '@agent/storage/runLease';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { flowKey } from '@agent/node/persistedFlow';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ReflectionFlowStateSchema } from '@agent/implementations/flows/reflection/ReflectionFlowState';
import {
  initializeDefaultSession,
  currentSession,
  teardownDefaultSession,
} from '@agent/runtime/SessionHandle';
import {
  formatCliHistoryDetailsText,
  listResumableCliHistoryEntries,
  readCliHistoryDetails,
} from '@cli/runtime/history';
import {
  RUN_META_SCHEMA_VERSION,
  aggregateId,
  CLI_RUN_STATUS,
  AgentCategory,
  HISTORY_RUN_STATUS,
  resolveHistoryRunStatus,
} from '@shared/schemas';
import type { RunId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';

const TOOL_USE_CONFIG: AgentConfig = AgentConfigSchema.parse({
  agent: 'orchestrator',
  model: 'deepseekT',
  instruction: 'Continue the session.',
  agentCategory: AgentCategory.ToolUse,
  workingDirectory: '/workspace',
});
const WORKFLOW_CONFIG: AgentConfig = AgentConfigSchema.parse({
  ...TOOL_USE_CONFIG,
  agent: 'correct',
  agentCategory: AgentCategory.Workflow,
  instruction: 'Continue the workflow.',
});

const tempDirs = useTempDirs();
setupPlatform(() => createTempDirPlatform('texra-history-status-', tempDirs));
beforeEach(() => {
  teardownDefaultSession();
  initializeDefaultSession({});
});

/** Registers a run, releases its lease, and writes a flow record. */
async function seedFlowRecord(
  id: RunId,
  config: AgentConfig,
  agent: string,
  shared: unknown,
): Promise<void> {
  await Effect.runPromise(
    registerRun(currentSession(), id, config, agent, {
      identity: { kind: 'agent', agent },
    }),
  );
  await releaseOwnedRunLease(id);
  await getRunStore(id).write(flowKey(id), {
    shared,
    cursor: { nextNodeId: 'start' },
  });
}

describe('CLI history status formatting', () => {
  it('keeps failed terminal outcomes in the frozen status even with a checkpoint', () => {
    expect(
      resolveHistoryRunStatus({
        outcome: 'failed',
        resumable: false,
      }),
    ).toBe('failed');
    // The NDJSON `status` field is frozen; a failed run that kept its
    // checkpoint is offered through the sibling `resumable` boolean instead.
    expect(
      resolveHistoryRunStatus({
        outcome: 'failed',
        resumable: true,
      }),
    ).toBe('failed');
  });

  it('marks interrupted tool-use sessions with flow records as resumable', () => {
    expect(
      resolveHistoryRunStatus({
        outcome: 'cancelled',
        resumable: true,
      }),
    ).toBe(HISTORY_RUN_STATUS.RESUMABLE);
  });

  it('marks flow records without a terminal outcome as resumable', () => {
    expect(resolveHistoryRunStatus({ resumable: true })).toBe(
      HISTORY_RUN_STATUS.RESUMABLE,
    );
  });

  it('filters history entries by the resumable flag, not the status', () => {
    expect(
      listResumableCliHistoryEntries([
        { id: 'resume-me', resumable: true },
        { id: 'done', resumable: false },
        { id: 'errored-with-checkpoint', resumable: true },
      ] as const),
    ).toEqual([
      { id: 'resume-me', resumable: true },
      { id: 'errored-with-checkpoint', resumable: true },
    ]);
  });

  it('reports outcome-free entries as unknown when no flow remains', () => {
    // A missing terminal outcome means the terminal write never happened
    // (crash, kill, old build) — reporting 'completed' would mask crashes.
    expect(resolveHistoryRunStatus({ resumable: false })).toBe('unknown');
  });

  it('prints resumable details instead of inventing completed status', () => {
    const text = formatCliHistoryDetailsText({
      id: 'abc123' as RunId,
      status: HISTORY_RUN_STATUS.RESUMABLE,
      meta: {
        schemaVersion: RUN_META_SCHEMA_VERSION,
        timestamp: '2026-06-03T05:03:06.717Z',
        identity: { kind: 'agent', agent: 'assistant' },
      },
      config: null,
      result: null,
      report: null,
      conversationPreview: null,
      files: [],
      hasFlowRecord: true,
    });

    expect(text).toContain('Status: Resumable');
    expect(text).toContain('Flow record: present');
    expect(text).not.toContain(`Status: ${CLI_RUN_STATUS.COMPLETED}`);
  });

  // `status` is a frozen contract, so `history show` answers it from the same
  // facts as `history list`: the checkpoint file, the stamped stream id, and
  // the terminal-rejection filter. A record the resume path could not load is
  // therefore still advertised here and refused, in its own words, on open —
  // what it must never become is 'completed' (the crash-masking guard).
  it.each([
    [
      'shared state that is not an object',
      TOOL_USE_CONFIG,
      'orchestrator',
      null,
    ],
    [
      'workflow state the category no longer accepts',
      WORKFLOW_CONFIG,
      'correct',
      { currentRound: 1, totalRounds: 2, messages: [] },
    ],
  ])(
    'still advertises a checkpoint with %s, and never calls it completed',
    async (description, config, agent, shared) => {
      const id = 'bad-f10' as RunId;
      await seedFlowRecord(id, config, agent, shared);

      const details = await readCliHistoryDetails(id);

      expect(details?.hasFlowRecord).toBe(true);
      expect(details?.status).toBe(HISTORY_RUN_STATUS.RESUMABLE);
      expect(details?.status).not.toBe(CLI_RUN_STATUS.COMPLETED);
      expect(formatCliHistoryDetailsText(details!)).toContain(
        'Flow record: present',
      );
    },
  );

  it('marks workflow flow records as CLI-resumable', async () => {
    const id = 'c0ffee-f10' as RunId;
    await seedFlowRecord(
      id,
      WORKFLOW_CONFIG,
      'correct',
      ReflectionFlowStateSchema.parse({
        currentRound: 1,
        totalRounds: 2,
        workspaceSnapshot: AgentWorkspaceState.emptySnapshot(),
        context: null,
        outputLocation: null,
        conversation: [],
        runStateSnapshot: {},
        roundOutputs: [],
        continueRounds: false,
        endTurn: false,
      }),
    );

    const details = await readCliHistoryDetails(id);

    expect(details?.hasFlowRecord).toBe(true);
    expect(details?.status).toBe(HISTORY_RUN_STATUS.RESUMABLE);
    expect(formatCliHistoryDetailsText(details!)).toContain(
      'Flow record: present',
    );
  });

  // A checkpoint alone is not enough: without a config there is no category
  // to resume under and nothing for a host to adopt, so the row says so.
  it('does not offer a run whose config is missing as resumable', async () => {
    const id = 'baad-c0f' as RunId;
    await Effect.runPromise(
      currentSession().commit([
        {
          type: 'run.start',
          aggregateId: aggregateId('run', id),
          identity: { kind: 'agent', agent: 'orchestrator' },
          category: AgentCategory.ToolUse,
          userFollowUpSupport: 'unsupported',
          isRemote: false,
          parent: null,
        },
      ]),
    );
    await getRunStore(id).write(flowKey(id), {
      shared: {},
      cursor: { nextNodeId: 'start' },
    });

    const details = await readCliHistoryDetails(id);

    expect(details?.hasFlowRecord).toBe(true);
    expect(details?.status).not.toBe(HISTORY_RUN_STATUS.RESUMABLE);
  });
});
