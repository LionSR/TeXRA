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
  CLI_HISTORY_RESUMABLE_STATUS,
  formatCliHistoryDetailsText,
  resumableCliHistoryEntries,
  readCliHistoryDetails,
} from '@cli/runtime/history';
import {
  EXECUTION_META_SCHEMA_VERSION,
  EXECUTION_STATUS,
  AgentCategory,
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
    flowName: 'test',
    shared,
    createdAt: new Date().toISOString(),
    cursor: { nextNodeId: 'start' },
    nodes: [],
  });
}

describe('CLI history status formatting', () => {
  it('keeps failed terminal outcomes authoritative', () => {
    expect(
      resolveHistoryRunStatus({
        outcome: 'failed',
        resumable: false,
      }),
    ).toBe('failed');
  });

  it('marks interrupted tool-use sessions with flow records as resumable', () => {
    expect(
      resolveHistoryRunStatus({
        outcome: 'cancelled',
        resumable: true,
      }),
    ).toBe(CLI_HISTORY_RESUMABLE_STATUS);

    expect(
      resumableCliHistoryEntries([
        {
          id: 'stopped-with-flow',
          status: resolveHistoryRunStatus({
            outcome: 'cancelled',
            resumable: true,
          }),
        },
      ]),
    ).toEqual([
      { id: 'stopped-with-flow', status: CLI_HISTORY_RESUMABLE_STATUS },
    ]);
  });

  it('marks flow records without a terminal outcome as resumable', () => {
    expect(resolveHistoryRunStatus({ resumable: true })).toBe(
      CLI_HISTORY_RESUMABLE_STATUS,
    );
  });

  it('filters history entries to resumable sessions only', () => {
    expect(
      resumableCliHistoryEntries([
        { id: 'resume-me', status: CLI_HISTORY_RESUMABLE_STATUS },
        { id: 'done', status: 'completed' },
        { id: 'errored', status: 'failed' },
      ] as const),
    ).toEqual([{ id: 'resume-me', status: CLI_HISTORY_RESUMABLE_STATUS }]);
  });

  it('reports outcome-free entries as unknown when no flow remains', () => {
    // A missing terminal outcome means the terminal write never happened
    // (crash, kill, old build) — reporting 'completed' would mask crashes.
    expect(resolveHistoryRunStatus({ resumable: false })).toBe('unknown');
  });

  it('prints resumable details instead of inventing completed status', () => {
    const text = formatCliHistoryDetailsText({
      id: 'abc123' as ExecutionId,
      status: CLI_HISTORY_RESUMABLE_STATUS,
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

  it('does not mark invalid flow records as resumable', async () => {
    const id = 'abc123' as ExecutionId;
    await seedFlowRecord(id, TOOL_USE_CONFIG, 'orchestrator', null);

    const details = await readCliHistoryDetails(id);

    expect(details?.hasFlowRecord).toBe(false);
    // Absent terminal status without a valid flow record is reported as
    // 'unknown', never invented as completed (crash-masking guard).
    expect(details?.status).toBe('unknown');
    expect(formatCliHistoryDetailsText(details!)).not.toContain(
      'Flow record: present',
    );
  });

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
    expect(details?.status).toBe(CLI_HISTORY_RESUMABLE_STATUS);
    expect(formatCliHistoryDetailsText(details!)).toContain(
      'Flow record: present',
    );
  });

  it('does not mark category-invalid workflow checkpoints as resumable', async () => {
    const id = 'workflow-with-retired-state' as ExecutionId;
    await seedFlowRecord(id, WORKFLOW_CONFIG, 'correct', {
      currentRound: 1,
      totalRounds: 2,
      messages: [],
    });

    const details = await readCliHistoryDetails(id);

    expect(details?.hasFlowRecord).toBe(false);
    expect(details?.status).toBe('unknown');
  });
});
