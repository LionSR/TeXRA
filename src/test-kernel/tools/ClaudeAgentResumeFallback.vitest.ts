// Regression coverage for the claude_agent tool's resume fallback: when a
// caller passes a session_id whose in-memory ClaudeAgentSessions registry
// entry is gone (extension reload, host crash, or a stale id from an older
// run). The first fallback must claim the id before asynchronous setup, while
// concurrent calls wait for that loop and then enqueue through the ordinary
// follow-up path.

import pDefer from 'p-defer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChildRunPorts,
  ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { ClaudeAgentSessions } from '@tools/agentCliSessionStores';

const mocks = vi.hoisted(() => ({
  requestBashApproval: vi.fn(),
  getCurrentToolContexts: vi.fn(),
  registerExecution: vi.fn(),
  getExecutionStore: vi.fn(),
  ensureRunDir: vi.fn(),
  createChildStream: vi.fn(),
  startChildRunLoop: vi.fn(),
  currentSession: vi.fn(),
  query: vi.fn(),
  buildClaudeAgentEnv: vi.fn(),
  enqueueFollowUp: vi.fn(),
}));

vi.mock('@tools/approval/bashApproval', () => ({
  requestBashApproval: mocks.requestBashApproval,
  buildBashApprovalRejectedResult: vi.fn(),
}));

vi.mock('@agent/followUp/ToolFileInteractionContext', () => ({
  getCurrentToolContexts: mocks.getCurrentToolContexts,
}));

vi.mock('@agent/runtime/RunContext', () => ({
  getRunContextExecutionId: (ctx: any) => ctx?.executionId,
  getRunContextStreamId: (ctx: any) => ctx?.streamId,
  getRunContextWorkingDirectory: (ctx: any) => ctx?.workingDirectory,
  getRunContextRuntimeHost: (ctx: any) => ctx?.runtimeHost,
}));

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.currentSession,
}));

vi.mock('@agent/storage', () => ({
  registerExecution: mocks.registerExecution,
  getExecutionStore: mocks.getExecutionStore,
}));

vi.mock('@utils/files/taskRunStorage', () => ({
  ensureRunDir: mocks.ensureRunDir,
}));

vi.mock('@tools/childStream', () => ({
  createChildStream: mocks.createChildStream,
}));

vi.mock('@agent/runtime/childRunLoop', () => ({
  startChildRunLoop: mocks.startChildRunLoop,
}));

vi.mock('@tools/claudeAgentConfig', () => ({
  getClaudeAgentPermissionMode: () => 'acceptEdits',
  getClaudeAgentModel: () => 'claude-sonnet-4-6',
  getClaudeAgentEffort: () => 'high',
  buildClaudeAgentEnv: mocks.buildClaudeAgentEnv,
  buildClaudeAgentConfig: () => ({
    agent: 'claude_agent',
    model: 'Claude Code CLI',
    instruction: 'test',
    agentCategory: 'toolUse',
  }),
}));

vi.mock('@tools/claudeAgentImport', () => ({
  importClaudeAgentSdk: async () => mocks.query,
  findClaudeBinaryPath: async () => undefined,
}));

import { ClaudeAgentTool } from '@tools/claudeAgent';
import { createFakeAgentCliChildStream } from '../support/agentCliResumeTestUtils';

const parentStreamId = 'stream:parent' as StreamTabId;
const childStreamId = 'stream:claude-child' as StreamTabId;
const executionId = 'parent-exec' as ExecutionId;

async function* streamMessages(messages: unknown[]): AsyncGenerator<unknown> {
  for (const message of messages) {
    yield message;
  }
}

describe('claude_agent tool — resume fallback for a torn-down registry', () => {
  afterEach(() => {
    vi.clearAllMocks();
    // Clear anything a test registered into the real (module-level) registry.
    ClaudeAgentSessions.releaseByExecutionId(executionId);
    ClaudeAgentSessions.release('stale-session');
  });

  function setupCommonMocks(): void {
    mocks.startChildRunLoop.mockReset();
    mocks.buildClaudeAgentEnv.mockReset();
    mocks.requestBashApproval.mockResolvedValue({ accepted: true });
    mocks.getCurrentToolContexts.mockReturnValue({
      runContext: {
        streamId: parentStreamId,
        executionId,
        workingDirectory: undefined,
        runtimeHost: { name: 'fake-runtime-host' },
      },
      callContext: { tracker: {}, hooks: {} },
    });
    mocks.registerExecution.mockResolvedValue(undefined);
    mocks.getExecutionStore.mockReturnValue({ write: async () => {} });
    mocks.ensureRunDir.mockResolvedValue(undefined);
    mocks.buildClaudeAgentEnv.mockResolvedValue({});
    mocks.createChildStream.mockReturnValue(
      createFakeAgentCliChildStream(childStreamId),
    );
    mocks.currentSession.mockReturnValue({
      followUps: { acquire: () => ({ enqueue: mocks.enqueueFollowUp }) },
    });
  }

  it('seeds the fallback launch with the stale session_id so the SDK resumes from disk', async () => {
    setupCommonMocks();
    mocks.query.mockReturnValue(
      streamMessages([
        {
          type: 'result',
          subtype: 'success',
          session_id: 'stale-session',
          result: 'Resumed and continued.',
        },
      ]),
    );

    const tool = new ClaudeAgentTool();
    await tool.call({
      prompt: 'continue the refactor',
      session_id: 'stale-session',
    });

    expect(mocks.startChildRunLoop).toHaveBeenCalledTimes(1);
    const [loopParams] = mocks.startChildRunLoop.mock.calls[0] as [
      { strategy: ChildRunStrategy<unknown> },
    ];
    const ports: ChildRunPorts = { notify: () => {}, recordCost: () => {} };
    await loopParams.strategy.launch(ports, new AbortController());

    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [callArgs] = mocks.query.mock.calls[0] as [
      { options: { resume?: string } },
    ];
    expect(callArgs.options.resume).toBe('stale-session');
  });

  it('launches one fallback loop when concurrent calls use the same stale session_id', async () => {
    setupCommonMocks();
    const envStarted = pDefer<void>();
    const envReady = pDefer<NodeJS.ProcessEnv>();
    const executions = { getAgentHandleByStream: () => undefined } as any;
    let strategy: ChildRunStrategy<unknown> | undefined;
    mocks.buildClaudeAgentEnv.mockImplementation(() => {
      envStarted.resolve(undefined);
      return envReady.promise;
    });
    mocks.startChildRunLoop.mockImplementation(
      (params: { strategy: ChildRunStrategy<unknown> }) => {
        strategy = params.strategy;
      },
    );

    const tool = new ClaudeAgentTool();
    const first = tool.call({
      prompt: 'continue the refactor',
      session_id: 'stale-session',
    });
    await envStarted.promise;

    const second = tool.call({
      prompt: 'also update the tests',
      session_id: 'stale-session',
    });
    await Promise.resolve();

    expect(mocks.buildClaudeAgentEnv).toHaveBeenCalledTimes(1);
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();

    envReady.resolve({});
    const firstResult = await first;
    strategy?.onTurnSuccess?.({ sessionId: 'stale-session' }, {
      executions,
    } as any);
    const secondResult = await second;

    expect(firstResult.status).toBe('executed');
    expect(secondResult.summary).toMatch(/Follow-up queued/);
    expect(mocks.startChildRunLoop).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueFollowUp).toHaveBeenCalledOnce();
    expect(mocks.enqueueFollowUp).toHaveBeenCalledWith({
      text: 'also update the tests',
    });

    strategy?.releaseSessionOwnership?.();
    expect(ClaudeAgentSessions.lookup('stale-session')).toBeUndefined();
  });

  it('lets a waiting caller own the fallback after the first launch fails', async () => {
    setupCommonMocks();
    const firstEnvStarted = pDefer<void>();
    const firstEnv = pDefer<NodeJS.ProcessEnv>();
    let strategy: ChildRunStrategy<unknown> | undefined;
    mocks.buildClaudeAgentEnv
      .mockImplementationOnce(() => {
        firstEnvStarted.resolve(undefined);
        return firstEnv.promise;
      })
      .mockResolvedValueOnce({});
    mocks.startChildRunLoop.mockImplementation(
      (params: { strategy: ChildRunStrategy<unknown> }) => {
        strategy = params.strategy;
      },
    );

    const tool = new ClaudeAgentTool();
    const first = tool.call({
      prompt: 'first attempt',
      session_id: 'stale-session',
    });
    await firstEnvStarted.promise;
    const second = tool.call({
      prompt: 'retry from the waiter',
      session_id: 'stale-session',
    });
    await Promise.resolve();

    firstEnv.reject(new Error('first environment failed'));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe('error');
    expect(secondResult.status).toBe('executed');
    expect(secondResult.summary).toMatch(/Launched Claude Code CLI/);
    expect(mocks.buildClaudeAgentEnv).toHaveBeenCalledTimes(2);
    expect(mocks.startChildRunLoop).toHaveBeenCalledOnce();

    strategy?.releaseSessionOwnership?.();
    expect(ClaudeAgentSessions.lookup('stale-session')).toBeUndefined();
  });

  it('still enqueues a follow-up (no fresh launch) when session_id IS active in the registry', async () => {
    setupCommonMocks();
    ClaudeAgentSessions.register('sess-resumed', {
      childStreamId,
      parentStreamId,
      executionId,
      executions: { getAgentHandleByStream: () => undefined } as any,
      model: 'claude-sonnet-4-6',
      permissionMode: 'acceptEdits',
      effort: 'high',
    });

    const result = await new ClaudeAgentTool().call({
      prompt: 'one more follow-up',
      session_id: 'sess-resumed',
    });

    expect(result.status).toBe('executed');
    expect(result.summary).toMatch(/Follow-up queued/);
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });
});
