import { describe, expect, it } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import {
  EXECUTION_META_SCHEMA_VERSION,
  registerExecution,
  getExecutionStore,
} from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { flowKey } from '@agent/node/persistedFlow';
import {
  CLI_HISTORY_RESUMABLE_STATUS,
  formatCliHistoryDetailsText,
  resumableCliHistoryEntries,
  readCliHistoryDetails,
  resolveCliHistoryStatus,
  userStartedCliHistoryEntries,
} from '@cli/runtime/history';
import { EXECUTION_STATUS, type ExecutionId } from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

const TOOL_USE_CONFIG: AgentConfig = {
  inputFiles: [],
  contextFiles: [],
  mediaFiles: [],
  outputFiles: [],
  editedFile: null,
  agent: 'orchestrator',
  model: 'deepseekT',
  instruction: 'Continue the session.',
  agentCategory: AgentCategory.ToolUse,
  editedFiles: [],
  toolConfig: DEFAULT_TOOL_CONFIG,
  memories: [],
  workingDirectory: '/workspace',
  cliOutputFile: null,
  cliMultiAgentPresetId: null,
};
const WORKFLOW_CONFIG: AgentConfig = {
  ...TOOL_USE_CONFIG,
  agent: 'correct',
  agentCategory: AgentCategory.Workflow,
  instruction: 'Continue the workflow.',
};

setupPlatform({ workspacePath: '/workspace' });

describe('CLI history status formatting', () => {
  it('keeps failed terminal statuses authoritative', () => {
    expect(
      resolveCliHistoryStatus({
        terminalStatus: EXECUTION_STATUS.ERROR,
        resumable: false,
      }),
    ).toBe(EXECUTION_STATUS.ERROR);
  });

  it('marks interrupted tool-use sessions with flow records as resumable', () => {
    expect(
      resolveCliHistoryStatus({
        terminalStatus: EXECUTION_STATUS.INTERRUPTED,
        resumable: true,
      }),
    ).toBe(CLI_HISTORY_RESUMABLE_STATUS);

    expect(
      resumableCliHistoryEntries([
        {
          id: 'stopped-with-flow',
          status: resolveCliHistoryStatus({
            terminalStatus: EXECUTION_STATUS.INTERRUPTED,
            resumable: true,
          }),
        },
      ]),
    ).toEqual([
      { id: 'stopped-with-flow', status: CLI_HISTORY_RESUMABLE_STATUS },
    ]);
  });

  it('uses nullish fallback semantics for persisted terminal status', () => {
    expect(
      resolveCliHistoryStatus({
        terminalStatus: '',
        resumable: false,
      }),
    ).toBe('');
  });

  it('marks flow records without terminal status as resumable', () => {
    expect(resolveCliHistoryStatus({ resumable: true })).toBe(
      CLI_HISTORY_RESUMABLE_STATUS,
    );
  });

  it('filters history entries to resumable sessions only', () => {
    expect(
      resumableCliHistoryEntries([
        { id: 'resume-me', status: CLI_HISTORY_RESUMABLE_STATUS },
        { id: 'done', status: EXECUTION_STATUS.COMPLETED },
        { id: 'errored', status: EXECUTION_STATUS.ERROR },
      ]),
    ).toEqual([{ id: 'resume-me', status: CLI_HISTORY_RESUMABLE_STATUS }]);
  });

  it('filters history entries to user-started sessions only', () => {
    expect(
      userStartedCliHistoryEntries([
        { id: 'root' },
        { id: 'child-with-parent', parentExecutionId: 'root' as ExecutionId },
      ]),
    ).toEqual([{ id: 'root' }]);
  });

  it('reports legacy terminal-status-free entries as unknown when no flow remains', () => {
    // A missing terminal status means the terminal write never happened
    // (crash, kill, old build) — reporting 'completed' would mask crashes.
    expect(resolveCliHistoryStatus({ resumable: false })).toBe('unknown');
  });

  it('prints resumable details instead of inventing completed status', () => {
    const text = formatCliHistoryDetailsText({
      id: 'abc123' as ExecutionId,
      status: CLI_HISTORY_RESUMABLE_STATUS,
      meta: {
        schemaVersion: EXECUTION_META_SCHEMA_VERSION,
        timestamp: '2026-06-03T05:03:06.717Z',
        category: 'toolUse',
      },
      config: null,
      result: null,
      report: null,
      conversationPreview: null,
      files: [],
      hasFlowRecord: true,
    });

    expect(text).toContain('Status: resumable');
    expect(text).toContain('Resumable flow record: present');
    expect(text).not.toContain(`Status: ${EXECUTION_STATUS.COMPLETED}`);
  });

  it('does not mark invalid flow records as resumable', async () => {
    const id = 'abc123' as ExecutionId;
    await registerExecution(id, TOOL_USE_CONFIG, 'orchestrator', undefined);
    await getExecutionStore(id).write(flowKey(id), {
      flowName: 'test',
      params: {},
      shared: null,
      createdAt: new Date().toISOString(),
      nodes: [],
    });

    const details = await readCliHistoryDetails(id);

    expect(details?.hasFlowRecord).toBe(false);
    // Absent terminal status without a valid flow record is reported as
    // 'unknown', never invented as completed (crash-masking guard).
    expect(details?.status).toBe('unknown');
    expect(formatCliHistoryDetailsText(details!)).not.toContain(
      'Resumable flow record: present',
    );
  });

  it('does not mark non-tool-use flow records as CLI-resumable', async () => {
    const id = 'workflow-with-flow' as ExecutionId;
    await registerExecution(id, WORKFLOW_CONFIG, 'correct', undefined);
    await getExecutionStore(id).write(flowKey(id), {
      flowName: 'test',
      params: {},
      shared: {
        currentRound: 1,
        totalRounds: 2,
        conversation: [],
      },
      createdAt: new Date().toISOString(),
      nodes: [],
    });

    const details = await readCliHistoryDetails(id);

    expect(details?.hasFlowRecord).toBe(false);
    expect(details?.status).toBe('unknown');
    expect(formatCliHistoryDetailsText(details!)).not.toContain(
      'Resumable flow record: present',
    );
  });
});
