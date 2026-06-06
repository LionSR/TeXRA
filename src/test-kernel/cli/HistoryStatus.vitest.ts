import { beforeEach, describe, expect, it } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import { registerExecution, getExecutionStore } from '@agent/storage';
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

beforeEach(async () => {
  const { initPlatform } = await import('@platform/platform');
  initPlatform(createFakePlatform({ workspacePath: '/workspace' }));
});

describe('CLI history status formatting', () => {
  it('keeps terminal statuses authoritative', () => {
    expect(
      resolveCliHistoryStatus({
        terminalStatus: EXECUTION_STATUS.ERROR,
        hasFlowRecord: true,
      }),
    ).toBe(EXECUTION_STATUS.ERROR);
    expect(
      resolveCliHistoryStatus({
        terminalStatus: EXECUTION_STATUS.INTERRUPTED,
        hasFlowRecord: true,
      }),
    ).toBe(EXECUTION_STATUS.INTERRUPTED);
  });

  it('uses nullish fallback semantics for persisted terminal status', () => {
    expect(
      resolveCliHistoryStatus({
        terminalStatus: '',
        hasFlowRecord: true,
      }),
    ).toBe('');
  });

  it('marks flow records without terminal status as resumable', () => {
    expect(resolveCliHistoryStatus({ hasFlowRecord: true })).toBe(
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
        { id: 'root-with-depth', delegationDepth: 0 },
        { id: 'child-with-parent', parentExecutionId: 'root' as ExecutionId },
        { id: 'child-with-depth', delegationDepth: 1 },
      ]),
    ).toEqual([{ id: 'root' }, { id: 'root-with-depth', delegationDepth: 0 }]);
  });

  it('keeps legacy terminal-status-free entries completed when no flow remains', () => {
    expect(resolveCliHistoryStatus({ hasFlowRecord: false })).toBe(
      EXECUTION_STATUS.COMPLETED,
    );
  });

  it('prints resumable details instead of inventing completed status', () => {
    const text = formatCliHistoryDetailsText({
      id: 'abc123' as ExecutionId,
      status: CLI_HISTORY_RESUMABLE_STATUS,
      meta: {
        timestamp: '2026-06-03T05:03:06.717Z',
        category: 'toolUse',
        delegationDepth: 0,
      },
      config: null,
      resultMeta: null,
      report: null,
      conversationPreview: null,
      files: [],
      hasFlowRecord: true,
    });

    expect(text).toContain('Status: resumable');
    expect(text).toContain('Delegation depth: 0');
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
    expect(details?.status).toBe(EXECUTION_STATUS.COMPLETED);
    expect(formatCliHistoryDetailsText(details!)).not.toContain(
      'Resumable flow record: present',
    );
  });
});
