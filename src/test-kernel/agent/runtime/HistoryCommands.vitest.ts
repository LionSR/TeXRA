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
  parse: vi.fn((value: unknown) => value),
}));

const goalStoreMock = vi.hoisted(() => ({
  forgetByExecutionIds: vi.fn(),
}));

vi.mock('@agent/storage', () => storageMock);
vi.mock('@agent/core/definition/AgentConfig', async () => {
  const { z } = await import('zod');
  const schema = z.any();
  schema.parse = agentConfigMock.parse as typeof schema.parse;
  return { AgentConfigSchema: schema };
});
vi.mock('@tools/goal', () => ({
  GoalStore: goalStoreMock,
}));

import {
  clearRuntimeHistoryStoreCache,
  countRuntimeHistoryExecutions,
  getRuntimeMostRecentSingleToolUseModel,
  hasRuntimeExecutionHistory,
  listRuntimeHistoryWorkspaceFiles,
  listRuntimeHistoryExecutions,
  readRuntimeHistoryConfig,
  readRuntimeHistoryExecutionRecord,
  readRuntimeHistoryTerminalStatus,
  repairRuntimeHistoryTerminalStatus,
  requestClearRuntimeHistoryExecutions,
  requestDeleteRuntimeHistoryExecution,
  writeRuntimeHistoryResultMeta,
  writeRuntimeTerminalStatus,
} from '@agent/runtime/historyCommands';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import {
  EXECUTION_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';

const EXECUTION_ID = 'abcdef123456' as ExecutionId;
const STREAM_ID = 'history@deepseek#abcdef123456' as StreamTabId;

function createRecordingHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
  };
}

function trackActiveExecution(session: SessionHandle): void {
  const handle = {
    executionId: EXECUTION_ID,
    parentStreamId: STREAM_ID,
    category: 'toolUse',
    agentName: 'texra',
    startedAt: Date.now(),
    runtimeHost: createRecordingHost(),
    getProgress: () => ({}),
    updateProgress: vi.fn(),
  } as Parameters<SessionHandle['executions']['track']>[0];
  session.executions.track(handle);
}

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
    expect(agentConfigMock.parse).toHaveBeenCalledWith(config);
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

  it('repairs a missing terminal status without overwriting an existing one', async () => {
    storageMock.writeTerminalStatus.mockResolvedValue(undefined);

    executionStoreMock.readMeta.mockResolvedValueOnce({
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    await expect(
      repairRuntimeHistoryTerminalStatus(EXECUTION_ID),
    ).resolves.toEqual({
      status: 'written',
      terminalStatus: EXECUTION_STATUS.ERROR,
    });
    expect(storageMock.writeTerminalStatus).toHaveBeenCalledWith(
      EXECUTION_ID,
      EXECUTION_STATUS.ERROR,
    );

    executionStoreMock.readMeta.mockResolvedValueOnce({
      timestamp: '2026-01-01T00:00:00.000Z',
      terminalStatus: EXECUTION_STATUS.COMPLETED,
    });
    await expect(
      repairRuntimeHistoryTerminalStatus(EXECUTION_ID),
    ).resolves.toEqual({
      status: 'preserved',
      terminalStatus: EXECUTION_STATUS.COMPLETED,
    });
    expect(storageMock.writeTerminalStatus).toHaveBeenCalledTimes(1);
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
    expect(agentConfigMock.parse).toHaveBeenCalledWith(raw);
  });

  it('returns null when no stored config exists', async () => {
    executionStoreMock.readConfig.mockResolvedValue(null);

    await expect(readRuntimeHistoryConfig(EXECUTION_ID)).resolves.toBeNull();
    expect(agentConfigMock.parse).not.toHaveBeenCalled();
  });

  it('refuses runtime history deletion while the execution is still active', async () => {
    const session = new SessionHandle();
    try {
      trackActiveExecution(session);

      await expect(
        requestDeleteRuntimeHistoryExecution(EXECUTION_ID, { session }),
      ).resolves.toEqual({ status: 'running' });

      expect(storageMock.deleteExecution).not.toHaveBeenCalled();
      expect(goalStoreMock.forgetByExecutionIds).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it('guards deletion against active executions in any live session by default', async () => {
    const session = new SessionHandle();
    try {
      trackActiveExecution(session);

      await expect(
        requestDeleteRuntimeHistoryExecution(EXECUTION_ID),
      ).resolves.toEqual({ status: 'running' });

      expect(storageMock.deleteExecution).not.toHaveBeenCalled();
      expect(goalStoreMock.forgetByExecutionIds).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it('projects runtime history deletion as deleted or missing', async () => {
    const session = new SessionHandle();
    storageMock.deleteExecution.mockResolvedValueOnce(true);
    try {
      await expect(
        requestDeleteRuntimeHistoryExecution(EXECUTION_ID, { session }),
      ).resolves.toEqual({ status: 'deleted' });
      expect(storageMock.deleteExecution).toHaveBeenCalledWith(EXECUTION_ID);
      expect(goalStoreMock.forgetByExecutionIds).toHaveBeenCalledWith([
        EXECUTION_ID,
      ]);

      storageMock.deleteExecution.mockResolvedValueOnce(false);
      await expect(
        requestDeleteRuntimeHistoryExecution(EXECUTION_ID, { session }),
      ).resolves.toEqual({ status: 'missing' });
      expect(goalStoreMock.forgetByExecutionIds).toHaveBeenCalledTimes(1);
    } finally {
      session.dispose();
    }
  });

  it('clears history while excluding active runtime executions', async () => {
    const session = new SessionHandle();
    const deletedExecutionId = 'deleted000000' as ExecutionId;
    storageMock.deleteAllExecutions.mockResolvedValue([deletedExecutionId]);

    try {
      trackActiveExecution(session);

      await expect(
        requestClearRuntimeHistoryExecutions({ session }),
      ).resolves.toEqual({
        deletedExecutionIds: [deletedExecutionId],
        activeExecutionIds: [EXECUTION_ID],
      });

      expect(storageMock.deleteAllExecutions).toHaveBeenCalledWith(
        new Set([EXECUTION_ID]),
      );
      expect(goalStoreMock.forgetByExecutionIds).toHaveBeenCalledWith([
        deletedExecutionId,
      ]);
    } finally {
      session.dispose();
    }
  });

  it('guards clear-history against active executions in any live session by default', async () => {
    const session = new SessionHandle();
    const deletedExecutionId = 'deleted000000' as ExecutionId;
    storageMock.deleteAllExecutions.mockResolvedValue([deletedExecutionId]);

    try {
      trackActiveExecution(session);

      await expect(requestClearRuntimeHistoryExecutions()).resolves.toEqual({
        deletedExecutionIds: [deletedExecutionId],
        activeExecutionIds: [EXECUTION_ID],
      });

      expect(storageMock.deleteAllExecutions).toHaveBeenCalledWith(
        new Set([EXECUTION_ID]),
      );
      expect(goalStoreMock.forgetByExecutionIds).toHaveBeenCalledWith([
        deletedExecutionId,
      ]);
    } finally {
      session.dispose();
    }
  });

  it('does not forget runtime goals when clear-history removes no executions', async () => {
    const session = new SessionHandle();
    storageMock.deleteAllExecutions.mockResolvedValue([]);

    try {
      await expect(
        requestClearRuntimeHistoryExecutions({ session }),
      ).resolves.toEqual({
        deletedExecutionIds: [],
        activeExecutionIds: [],
      });

      expect(storageMock.deleteAllExecutions).toHaveBeenCalledWith(new Set());
      expect(goalStoreMock.forgetByExecutionIds).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it('clears the runtime history store cache', () => {
    clearRuntimeHistoryStoreCache();

    expect(storageMock.clearStoreCache).toHaveBeenCalledOnce();
  });
});
