import { afterEach, describe, expect, it, vi } from 'vitest';

const executionStoreMock = vi.hoisted(() => ({
  readConversation: vi.fn(),
  readConfig: vi.fn(),
  readMeta: vi.fn(),
  readReport: vi.fn(),
  readResultMeta: vi.fn(),
  readWorkspaceFiles: vi.fn(),
  writeResultMeta: vi.fn(),
}));

const storageMock = vi.hoisted(() => ({
  clearStoreCache: vi.fn(),
  deleteAllExecutions: vi.fn(),
  deleteExecution: vi.fn(),
  getExecutionStore: vi.fn(() => executionStoreMock),
  listExecutionWorkspaceFiles: vi.fn(),
  listExecutions: vi.fn(),
  writeTerminalStatus: vi.fn(),
}));

const agentConfigMock = vi.hoisted(() => ({
  AgentConfigSchema: {
    parse: vi.fn((value: unknown) => value),
  },
}));

vi.mock('@agent/storage', () => storageMock);
vi.mock('@agent/core/definition/AgentConfig', () => agentConfigMock);

import {
  clearRuntimeHistoryStoreCache,
  countRuntimeHistoryExecutions,
  deleteAllRuntimeHistoryExecutions,
  deleteRuntimeHistoryExecution,
  getRuntimeMostRecentSingleToolUseModel,
  hasRuntimeExecutionHistory,
  listRuntimeHistoryWorkspaceFiles,
  listRuntimeHistoryExecutions,
  readRuntimeHistoryConfig,
  readRuntimeHistoryExecutionRecord,
  readRuntimeHistoryTerminalStatus,
  writeRuntimeHistoryResultMeta,
  writeRuntimeTerminalStatus,
} from '@agent/runtime/historyCommands';
import type { ExecutionId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';

const EXECUTION_ID = 'abcdef123456' as ExecutionId;

describe('runtime history commands', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists and counts stored executions through runtime projections', async () => {
    const entry = {
      id: EXECUTION_ID,
      timestamp: '2026-01-01T00:00:00.000Z',
      agent: 'proof',
      model: 'deepseekT',
      agentConfig: { model: 'deepseekT' },
      terminalStatus: 'completed',
    };
    storageMock.listExecutions.mockResolvedValue([entry]);

    await expect(listRuntimeHistoryExecutions()).resolves.toEqual([entry]);
    await expect(countRuntimeHistoryExecutions()).resolves.toBe(1);
    await expect(hasRuntimeExecutionHistory()).resolves.toBe(true);

    expect(storageMock.listExecutions).toHaveBeenCalledTimes(3);
  });

  it('reports absence of execution history', async () => {
    storageMock.listExecutions.mockResolvedValue([]);

    await expect(hasRuntimeExecutionHistory()).resolves.toBe(false);
  });

  it('finds the most recent single-agent tool-use model', async () => {
    storageMock.listExecutions.mockResolvedValue([
      {
        id: 'team00000000' as ExecutionId,
        timestamp: '2026-01-03T00:00:00.000Z',
        agent: 'orchestrator',
        model: 'team-model',
        agentConfig: {
          agentCategory: AgentCategory.ToolUse,
          cliMultiAgentPresetId: 'physicists',
          model: 'team-model',
        },
      },
      {
        id: 'reflection00' as ExecutionId,
        timestamp: '2026-01-02T00:00:00.000Z',
        agent: 'reviewer',
        model: 'reflection-model',
        agentConfig: {
          agentCategory: AgentCategory.Workflow,
          model: 'reflection-model',
        },
      },
      {
        id: EXECUTION_ID,
        timestamp: '2026-01-01T00:00:00.000Z',
        agent: 'texra',
        model: 'chat-model',
        agentConfig: {
          agentCategory: AgentCategory.ToolUse,
          model: 'chat-model',
        },
      },
    ]);

    await expect(getRuntimeMostRecentSingleToolUseModel()).resolves.toBe(
      'chat-model',
    );
  });

  it('reads a full stored execution record', async () => {
    const meta = { timestamp: '2026-01-01T00:00:00.000Z' };
    const config = { agent: 'proof', model: 'deepseekT' };
    const resultMeta = { success: true };
    const conversation = [{ role: 'user', content: 'Check this.' }];
    executionStoreMock.readMeta.mockResolvedValue(meta);
    executionStoreMock.readConfig.mockResolvedValue(config);
    executionStoreMock.readResultMeta.mockResolvedValue(resultMeta);
    executionStoreMock.readReport.mockResolvedValue('done');
    executionStoreMock.readConversation.mockResolvedValue(conversation);
    executionStoreMock.readWorkspaceFiles.mockResolvedValue(['main.tex']);

    await expect(
      readRuntimeHistoryExecutionRecord(EXECUTION_ID),
    ).resolves.toEqual({
      meta,
      config,
      resultMeta,
      report: 'done',
      conversation,
      workspaceFilePaths: ['main.tex'],
    });
    expect(storageMock.getExecutionStore).toHaveBeenCalledWith(EXECUTION_ID);
  });

  it('reads terminal status without exposing execution storage', async () => {
    executionStoreMock.readMeta.mockResolvedValue({
      timestamp: '2026-01-01T00:00:00.000Z',
      terminalStatus: 'completed',
    });

    await expect(readRuntimeHistoryTerminalStatus(EXECUTION_ID)).resolves.toBe(
      'completed',
    );
  });

  it('writes terminal status and result metadata through runtime commands', async () => {
    const resultMeta = { success: true };
    storageMock.writeTerminalStatus.mockResolvedValue(undefined);
    executionStoreMock.writeResultMeta.mockResolvedValue(undefined);

    await expect(
      writeRuntimeTerminalStatus(EXECUTION_ID, 'completed'),
    ).resolves.toBeUndefined();
    await expect(
      writeRuntimeHistoryResultMeta(EXECUTION_ID, resultMeta),
    ).resolves.toBeUndefined();

    expect(storageMock.writeTerminalStatus).toHaveBeenCalledWith(
      EXECUTION_ID,
      'completed',
    );
    expect(storageMock.getExecutionStore).toHaveBeenCalledWith(EXECUTION_ID);
    expect(executionStoreMock.writeResultMeta).toHaveBeenCalledWith(resultMeta);
  });

  it('lists runtime history workspace files', async () => {
    const config = null;
    const files = [
      {
        path: 'main.tex',
        displayPath: 'workspace/main.tex',
        absolutePath: '/tmp/main.tex',
        size: 42,
        isDirectory: false,
      },
    ];
    storageMock.listExecutionWorkspaceFiles.mockResolvedValue(files);

    await expect(
      listRuntimeHistoryWorkspaceFiles(config, ['main.tex']),
    ).resolves.toBe(files);

    expect(storageMock.listExecutionWorkspaceFiles).toHaveBeenCalledWith(
      config,
      ['main.tex'],
    );
  });

  it('reads and parses a stored execution config', async () => {
    const raw = {
      agent: 'proof',
      model: 'deepseekT',
      instruction: 'Check the proof.',
    };
    executionStoreMock.readConfig.mockResolvedValue(raw);

    await expect(readRuntimeHistoryConfig(EXECUTION_ID)).resolves.toEqual(raw);

    expect(storageMock.getExecutionStore).toHaveBeenCalledWith(EXECUTION_ID);
    expect(agentConfigMock.AgentConfigSchema.parse).toHaveBeenCalledWith(raw);
  });

  it('returns null when no stored config exists', async () => {
    executionStoreMock.readConfig.mockResolvedValue(null);

    await expect(readRuntimeHistoryConfig(EXECUTION_ID)).resolves.toBeNull();
    expect(agentConfigMock.AgentConfigSchema.parse).not.toHaveBeenCalled();
  });

  it('deletes history through runtime commands', async () => {
    const active = new Set<ExecutionId>([EXECUTION_ID]);
    storageMock.deleteExecution.mockResolvedValue(true);
    storageMock.deleteAllExecutions.mockResolvedValue([EXECUTION_ID]);

    await expect(deleteRuntimeHistoryExecution(EXECUTION_ID)).resolves.toBe(
      true,
    );
    await expect(deleteAllRuntimeHistoryExecutions(active)).resolves.toEqual([
      EXECUTION_ID,
    ]);

    expect(storageMock.deleteExecution).toHaveBeenCalledWith(EXECUTION_ID);
    expect(storageMock.deleteAllExecutions).toHaveBeenCalledWith(active);
  });

  it('clears the runtime history store cache', () => {
    clearRuntimeHistoryStoreCache();

    expect(storageMock.clearStoreCache).toHaveBeenCalledOnce();
  });
});
