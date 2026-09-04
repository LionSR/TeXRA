import { describe, expect, it } from 'vitest';

import { registerExecution, getExecutionStore } from '@agent/storage';
import { releaseOwnedExecutionLease } from '@agent/storage/executionLease';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { flowKey } from '@agent/node/persistedFlow';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ReflectionFlowStateSchema } from '@agent/implementations/flows/reflection/ReflectionFlowState';
import {
  formatCliHistoryDetailsText,
  listResumableCliHistoryEntries,
  readCliHistoryDetails,
} from '@cli/runtime/history';
import {
  EXECUTION_META_SCHEMA_VERSION,
  EXECUTION_STATUS,
  AgentCategory,
  HISTORY_RUN_STATUS,
  resolveHistoryRunStatus,
} from '@shared/schemas';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';

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

setupPlatform({ workspacePath: '/workspace' });

/** Registers an execution, releases its lease, and writes a flow record. */
async function seedFlowRecord(
  id: ExecutionId,
  config: AgentConfig,
  agent: string,
  shared: unknown,
): Promise<void> {
  await registerExecution(id, config, agent, {
    streamId: `${agent}@deepseekT#${id}` as StreamTabId,
    identity: { kind: 'agent', agent },
  });
  await releaseOwnedExecutionLease(id);
  await getExecutionStore(id).write(flowKey(id), {
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
      id: 'abc123' as ExecutionId,
      status: HISTORY_RUN_STATUS.RESUMABLE,
      meta: {
        schemaVersion: EXECUTION_META_SCHEMA_VERSION,
        timestamp: '2026-06-03T05:03:06.717Z',
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
    expect(text).not.toContain(`Status: ${EXECUTION_STATUS.COMPLETED}`);
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
      const id = `unloadable-${description.split(' ')[0]}` as ExecutionId;
      await seedFlowRecord(id, config, agent, shared);

      const details = await readCliHistoryDetails(id);

      expect(details?.hasFlowRecord).toBe(true);
      expect(details?.status).toBe(HISTORY_RUN_STATUS.RESUMABLE);
      expect(details?.status).not.toBe(EXECUTION_STATUS.COMPLETED);
      expect(formatCliHistoryDetailsText(details!)).toContain(
        'Flow record: present',
      );
    },
  );

  it('marks workflow flow records as CLI-resumable', async () => {
    const id = 'workflow-with-flow' as ExecutionId;
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
});
