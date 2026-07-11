// Regression coverage for the claude_agent tool's resume fallback: when a
// caller passes a session_id whose in-memory ClaudeAgentSessions registry
// entry is gone (extension reload, host crash, or a stale id from an older
// run), the tool must NOT throw a "not active" ToolError like a raw
// resumeAgentCliSession() call would. It must mirror codex.ts's pattern —
// fall through to launching a fresh session that resumes the SDK session
// from disk via the `resume` option, rather than silently starting a blind
// new conversation or surfacing an error to the caller.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunTrace, StreamLogStore } from '@transcript';
import type { AgentTrace } from '@agent/trace';
import type {
  ChildRunPorts,
  ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { ClaudeAgentSessions } from '@tools/agentCliSessionStores';
import type { ChildStream } from '@tools/childStream';

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
  buildClaudeAgentEnv: async () => ({}),
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

const parentStreamId = 'stream:parent' as StreamTabId;
const childStreamId = 'stream:claude-child' as StreamTabId;
const executionId = 'parent-exec' as ExecutionId;

async function* streamMessages(messages: unknown[]): AsyncGenerator<unknown> {
  for (const message of messages) {
    yield message;
  }
}

function fakeLogger(): AgentTrace {
  const store = new StreamLogStore();
  return createRunTrace(childStreamId, store).trace;
}

function fakeChildStream(): ChildStream {
  return {
    childStreamId,
    logger: fakeLogger(),
    waitForInput: () => {},
    beginTurn: () => {},
    failTurn: () => {},
    finalize: async () => {},
  };
}

describe('claude_agent tool — resume fallback for a torn-down registry', () => {
  afterEach(() => {
    vi.clearAllMocks();
    // Clear anything a test registered into the real (module-level) registry.
    ClaudeAgentSessions.releaseMany(['stale-session', 'sess-resumed']);
  });

  function setupCommonMocks(): void {
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
    mocks.createChildStream.mockReturnValue(fakeChildStream());
    mocks.currentSession.mockReturnValue({
      followUps: { acquire: () => ({ enqueue: vi.fn() }) },
    });
  }

  it('falls through to a fresh launch instead of throwing when session_id is not in the in-memory registry', async () => {
    setupCommonMocks();
    expect(ClaudeAgentSessions.isActive('stale-session')).toBe(false);

    const tool = new ClaudeAgentTool();
    const result = await tool.call({
      prompt: 'continue the refactor',
      session_id: 'stale-session',
    });

    // Pre-fix, execute() unconditionally called resumeAgentCliSession() for
    // any session_id, which throws "... is not active ..." the moment the
    // in-memory registry doesn't have the id — surfacing as a tool error
    // instead of resuming. Post-fix it must launch a fresh session instead.
    expect(result.status).toBe('executed');
    expect(result.error).toBeUndefined();
    expect(mocks.startChildRunLoop).toHaveBeenCalledTimes(1);
  });

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

  it('registers the fallback session_id up front via onSessionStart, ahead of the first turn completing', async () => {
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

    // Pins the eager-registration mechanism itself: onSessionStart must make
    // the stale session_id observably active synchronously, independent of
    // whether the first turn has resolved yet.
    expect(ClaudeAgentSessions.isActive('stale-session')).toBe(false);
    loopParams.strategy.onSessionStart?.({
      executions: { getAgentHandleByStream: () => undefined } as any,
    } as any);
    expect(ClaudeAgentSessions.isActive('stale-session')).toBe(true);
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
