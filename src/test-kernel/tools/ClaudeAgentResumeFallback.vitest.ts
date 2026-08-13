// Launch and resume coverage for the claude_agent tool. The resume fallback
// applies when a caller passes a session_id whose in-memory
// ClaudeAgentSessions registry entry is gone (extension reload, host crash, or
// a stale id from an older run): the first fallback claims the id before
// asynchronous setup, while concurrent calls wait for that loop and then
// enqueue through the ordinary follow-up path.

import pDefer from 'p-defer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChildRunPorts,
  ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
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
  findClaudeBinaryPath: vi.fn(),
  submitFollowUp: vi.fn(async () => ({ status: 'sent' as const })),
}));

vi.mock('@tools/approval/bashApproval', () => ({
  requestBashApproval: mocks.requestBashApproval,
  buildBashApprovalRejectedResult: vi.fn(),
}));

vi.mock('@agent/followUp/ToolFileInteractionContext', () => ({
  getCurrentToolContexts: mocks.getCurrentToolContexts,
}));

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  submitFollowUp: mocks.submitFollowUp,
}));

vi.mock('@agent/runtime/RunContext', () => ({
  getRunContextExecutionId: (ctx: any) => ctx?.executionId,
  getRunContextStreamId: (ctx: any) => ctx?.streamId,
  getRunContextWorkingDirectory: (ctx: any) => ctx?.workingDirectory,
  getRunContextInteractions: (ctx: any) => ctx?.interactions,
}));

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.currentSession,
}));

vi.mock('@agent/storage', () => ({
  registerExecution: mocks.registerExecution,
  getExecutionStore: mocks.getExecutionStore,
}));

vi.mock('@agent/storage/executionLease', () => ({
  EXECUTION_LEASE_STALE_MS: 120_000,
  captureOwnedExecutionLease:
    (_executionId: ExecutionId) => (operation: () => unknown) =>
      operation(),
}));

vi.mock('@utils/files/taskRunStorage', () => ({
  ensureRunDir: mocks.ensureRunDir,
}));

vi.mock('@tools/delegation/childStream', () => ({
  createChildStream: mocks.createChildStream,
  childStreamDescription: (raw: string) => raw,
  getChildStreamId: (executionId: string, prefix: string) =>
    `${prefix}#${executionId}`,
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
  findClaudeBinaryPath: mocks.findClaudeBinaryPath,
}));

import { ClaudeAgentTool } from '@tools/claudeAgent';
import { createFakeAgentCliChildStream } from '../support/agentCliResumeTestUtils';

const parentStreamId = 'stream:parent' as StreamTabId;
const childStreamId = 'stream:claude-child' as StreamTabId;
const executionId = 'parent-exec' as ExecutionId;

function completedChildRunLoop(): { completion: Promise<void> } {
  return { completion: Promise.resolve() };
}

function stubExecutions(): any {
  return {
    getAgentHandleByStream: () => undefined,
    getHandle: () => undefined,
  };
}

function fakeToolContexts(extra: Record<string, unknown> = {}): unknown {
  return {
    runContext: {
      streamId: parentStreamId,
      executionId,
      interactions: { name: 'fake-runtime-host' },
      ...extra,
    },
    callContext: { tracker: {}, hooks: {} },
  };
}

function captureStrategy(): { strategy?: ChildRunStrategy<unknown> } {
  const captured: { strategy?: ChildRunStrategy<unknown> } = {};
  mocks.startChildRunLoop.mockImplementation(
    (params: { strategy: ChildRunStrategy<unknown> }) => {
      captured.strategy = params.strategy;
      return completedChildRunLoop();
    },
  );
  return captured;
}

describe('claude_agent tool launch and resume fallback', () => {
  beforeEach(() => {
    mocks.startChildRunLoop.mockReset();
    mocks.startChildRunLoop.mockReturnValue(completedChildRunLoop());
    mocks.buildClaudeAgentEnv.mockReset();
    mocks.findClaudeBinaryPath.mockReset();
    mocks.requestBashApproval.mockResolvedValue({ action: 'approve' });
    mocks.getCurrentToolContexts.mockReturnValue(fakeToolContexts());
    mocks.registerExecution.mockResolvedValue(undefined);
    mocks.getExecutionStore.mockReturnValue({ write: async () => {} });
    mocks.ensureRunDir.mockResolvedValue(undefined);
    mocks.buildClaudeAgentEnv.mockResolvedValue({});
    mocks.findClaudeBinaryPath.mockResolvedValue(undefined);
    mocks.createChildStream.mockReturnValue(
      createFakeAgentCliChildStream(childStreamId),
    );
    mocks.currentSession.mockReturnValue({
      followUps: { acquire: () => ({ enqueue: vi.fn() }) },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Clear anything a test registered into the real (module-level) registry.
    ClaudeAgentSessions.releaseByExecutionId(executionId);
    ClaudeAgentSessions.release('stale-session');
  });

  it('resolves the Claude binary before child creation and then tracks startup synchronously', async () => {
    const binaryPath = pDefer<string | undefined>();
    const executions = stubExecutions();
    const startupEvents: string[] = [];
    const originalTrackInFlight =
      ClaudeAgentSessions.trackInFlight.bind(ClaudeAgentSessions);
    const trackInFlight = vi
      .spyOn(ClaudeAgentSessions, 'trackInFlight')
      .mockImplementation((entry) => {
        startupEvents.push('tracked');
        originalTrackInFlight(entry);
      });
    mocks.findClaudeBinaryPath.mockReturnValue(binaryPath.promise);
    mocks.startChildRunLoop.mockImplementation(
      (params: { strategy: ChildRunStrategy<unknown> }) => {
        startupEvents.push('startLoop');
        params.strategy.onLoopStart?.({ executions } as any);
        startupEvents.push('startLoopReturned');
        return completedChildRunLoop();
      },
    );

    try {
      const launch = new ClaudeAgentTool().call({
        prompt: 'start after binary discovery',
      });
      await vi.waitFor(() =>
        expect(mocks.findClaudeBinaryPath).toHaveBeenCalledOnce(),
      );

      expect(mocks.registerExecution).not.toHaveBeenCalled();
      expect(mocks.createChildStream).not.toHaveBeenCalled();
      expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
      expect(trackInFlight).not.toHaveBeenCalled();

      binaryPath.resolve('/opt/claude');
      await expect(launch).resolves.toMatchObject({ status: 'executed' });

      expect(mocks.createChildStream).toHaveBeenCalledOnce();
      expect(mocks.startChildRunLoop).toHaveBeenCalledOnce();
      expect(trackInFlight).toHaveBeenCalledOnce();
      expect(startupEvents).toEqual([
        'startLoop',
        'tracked',
        'startLoopReturned',
      ]);
    } finally {
      const trackedExecutionId = trackInFlight.mock.calls[0]?.[0].executionId;
      trackInFlight.mockRestore();
      if (trackedExecutionId) {
        ClaudeAgentSessions.releaseByExecutionId(trackedExecutionId);
      }
    }
  });

  it('refuses a one-shot run whose follow-up could never be collected', async () => {
    mocks.getCurrentToolContexts.mockReturnValue(
      fakeToolContexts({ stopAfterCycle: true }),
    );

    const result = await new ClaudeAgentTool().call({
      prompt: 'must not launch into a run that ends first',
    });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining(
        'claude_code is unavailable in one-shot runs',
      ),
    });
    expect(mocks.requestBashApproval).not.toHaveBeenCalled();
    expect(mocks.registerExecution).not.toHaveBeenCalled();
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });

  it('does not create an execution when Claude binary discovery fails', async () => {
    mocks.findClaudeBinaryPath.mockRejectedValue(
      new Error('Claude binary lookup failed'),
    );

    const result = await new ClaudeAgentTool().call({
      prompt: 'must not create a stale child',
    });

    expect(result.status).toBe('error');
    expect(mocks.registerExecution).not.toHaveBeenCalled();
    expect(mocks.createChildStream).not.toHaveBeenCalled();
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });

  it('logs a detached run-loop rejection through the child trace', async () => {
    const childStream = createFakeAgentCliChildStream(childStreamId);
    const error = vi
      .spyOn(childStream.logger, 'error')
      .mockImplementation(() => {});
    const lateFailure = new Error('late Claude finalization failed');
    mocks.createChildStream.mockReturnValue(childStream);
    mocks.startChildRunLoop.mockReturnValue({
      completion: Promise.reject(lateFailure),
    });

    await expect(
      new ClaudeAgentTool().call({ prompt: 'launch Claude' }),
    ).resolves.toMatchObject({ status: 'executed' });
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(
        'Claude Agent run loop failed after launch',
        { data: lateFailure },
      );
    });
  });

  it('seeds the fallback launch with the stale session_id so the SDK resumes from disk', async () => {
    mocks.query.mockReturnValue(
      (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'stale-session',
          result: 'Resumed and continued.',
          modelUsage: {},
          total_cost_usd: 0,
        };
      })(),
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

  it('preserves legacy usage when a result has no modelUsage', async () => {
    const childStream = createFakeAgentCliChildStream(childStreamId);
    const publishUsage = vi.spyOn(childStream.logger, 'usage');
    mocks.createChildStream.mockReturnValue(childStream);
    mocks.query.mockReturnValue(
      (async function* () {
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          errors: ['failed before the first model call'],
          usage: { input_tokens: 12, output_tokens: 3 },
          total_cost_usd: 0,
        };
      })(),
    );
    const captured = captureStrategy();

    await new ClaudeAgentTool().call({ prompt: 'start Claude' });
    const turn = await captured.strategy?.launch?.(
      { notify: () => {}, recordCost: () => {} },
      new AbortController(),
    );
    if (!turn) throw new Error('Expected a Claude turn result');
    captured.strategy?.publishUsage?.(turn);

    expect(publishUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({ inputTokens: 12, outputTokens: 3 }),
      }),
      { recordTranscript: false },
    );
  });

  it('launches one fallback loop when concurrent calls use the same stale session_id', async () => {
    const envStarted = pDefer<void>();
    const envReady = pDefer<NodeJS.ProcessEnv>();
    const executions = stubExecutions();
    const captured = captureStrategy();
    mocks.buildClaudeAgentEnv.mockImplementation(() => {
      envStarted.resolve(undefined);
      return envReady.promise;
    });

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
    captured.strategy?.onTurnSuccess?.({ sessionId: 'stale-session' }, {
      executions,
    } as any);
    const secondResult = await second;

    expect(firstResult.status).toBe('executed');
    expect(secondResult.summary).toMatch(/Follow-up queued/);
    expect(mocks.startChildRunLoop).toHaveBeenCalledTimes(1);
    expect(mocks.submitFollowUp).toHaveBeenCalledOnce();
    expect(mocks.submitFollowUp).toHaveBeenCalledWith(
      childStreamId,
      'also update the tests',
      expect.objectContaining({ session: expect.anything() }),
    );

    captured.strategy?.releaseSessionOwnership?.();
    expect(ClaudeAgentSessions.lookup('stale-session')).toBeUndefined();
  });

  it('exposes an in-flight initial turn to the shared shutdown drain', async () => {
    const interrupt = vi.fn();
    const captured = captureStrategy();

    await new ClaudeAgentTool().call({
      prompt: 'start a long initial turn',
    });

    const executions = {
      getAgentHandleByStream: () => ({ interrupt }),
    } as any;
    captured.strategy?.onLoopStart?.({ executions } as any);
    ClaudeAgentSessions.interruptAll();

    expect(interrupt).toHaveBeenCalledOnce();
    captured.strategy?.releaseSessionOwnership?.();
  });

  it('lets a waiting caller own the fallback after the first launch fails', async () => {
    const firstEnvStarted = pDefer<void>();
    const firstEnv = pDefer<NodeJS.ProcessEnv>();
    const captured = captureStrategy();
    mocks.buildClaudeAgentEnv
      .mockImplementationOnce(() => {
        firstEnvStarted.resolve(undefined);
        return firstEnv.promise;
      })
      .mockResolvedValueOnce({});

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

    captured.strategy?.releaseSessionOwnership?.();
    expect(ClaudeAgentSessions.lookup('stale-session')).toBeUndefined();
  });

  it('still enqueues a follow-up (no fresh launch) when session_id IS active in the registry', async () => {
    ClaudeAgentSessions.register('sess-resumed', {
      childStreamId,
      executionId,
      executions: stubExecutions(),
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

  it('forks an active session into a distinct child and only forks its first turn', async () => {
    ClaudeAgentSessions.register('source-session', {
      childStreamId,
      executionId,
      executions: stubExecutions(),
      model: 'claude-sonnet-4-6',
      permissionMode: 'acceptEdits',
      effort: 'high',
    });
    let queryIndex = 0;
    mocks.query.mockImplementation(() => {
      queryIndex += 1;
      const sessionId = 'forked-session';
      return (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: sessionId,
          result: `Fork turn ${queryIndex}`,
          modelUsage: {},
          total_cost_usd: 0,
        };
      })();
    });
    const captured = captureStrategy();

    const result = await new ClaudeAgentTool().call({
      prompt: 'try a different proof',
      session_id: 'source-session',
      fork_session: true,
    });

    expect(result.status).toBe('executed');
    expect(mocks.submitFollowUp).not.toHaveBeenCalled();
    expect(mocks.startChildRunLoop).toHaveBeenCalledOnce();
    const ports: ChildRunPorts = { notify: () => {}, recordCost: () => {} };
    const firstTurn = await captured.strategy?.launch?.(
      ports,
      new AbortController(),
    );
    captured.strategy?.onTurnSuccess?.(firstTurn, {
      executions: stubExecutions(),
    } as any);
    await captured.strategy?.runTurn?.(
      [{ text: 'continue the fork', origin: 'user' }],
      ports,
      new AbortController(),
    );

    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[0]?.[0]).toMatchObject({
      options: { resume: 'source-session', forkSession: true },
    });
    expect(mocks.query.mock.calls[1]?.[0]).toMatchObject({
      options: { resume: 'forked-session' },
    });
    expect(mocks.query.mock.calls[1]?.[0].options).not.toHaveProperty(
      'forkSession',
    );
    expect(ClaudeAgentSessions.lookup('source-session')?.childStreamId).toBe(
      childStreamId,
    );
    expect(ClaudeAgentSessions.lookup('forked-session')).toBeDefined();
    captured.strategy?.releaseSessionOwnership?.();
    ClaudeAgentSessions.release('forked-session');
  });

  it('fails a fork whose success result omits session_id', async () => {
    mocks.query.mockReturnValue(
      (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Forked without identifying the new session.',
          modelUsage: {},
          total_cost_usd: 0,
        };
      })(),
    );
    const captured = captureStrategy();

    await new ClaudeAgentTool().call({
      prompt: 'try a different proof',
      session_id: 'source-session',
      fork_session: true,
    });
    const turn = (await captured.strategy?.launch?.(
      { notify: () => {}, recordCost: () => {} },
      new AbortController(),
    )) as
      | { isError: boolean; sessionId?: string; errorMessage?: string }
      | undefined;

    expect(turn?.isError).toBe(true);
    expect(turn?.sessionId).toBeUndefined();
    expect(turn?.errorMessage).toContain('missing session_id');
    expect(captured.strategy?.isTurnError?.(turn)).toBe(true);
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it('preserves a provider error after an earlier fork success result', async () => {
    mocks.query.mockReturnValue(
      (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Intermediate success without a session id.',
          modelUsage: {},
          total_cost_usd: 0,
        };
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          errors: ['provider failed after success'],
          modelUsage: {},
          total_cost_usd: 0,
        };
      })(),
    );
    const captured = captureStrategy();

    await new ClaudeAgentTool().call({
      prompt: 'try a different proof',
      session_id: 'source-session',
      fork_session: true,
    });
    const turn = (await captured.strategy?.launch?.(
      { notify: () => {}, recordCost: () => {} },
      new AbortController(),
    )) as
      | { isError: boolean; sessionId?: string; errorMessage?: string }
      | undefined;

    expect(turn?.isError).toBe(true);
    expect(turn?.sessionId).toBeUndefined();
    expect(turn?.errorMessage).toBe('provider failed after success');
  });

  it('rejects a fork from a live session owned by another stream', async () => {
    const sourceExecutionId = 'source-execution' as ExecutionId;
    const sourceOwner = 'stream:other-owner' as StreamTabId;
    const handle = testExecutionHandle({
      executionId: sourceExecutionId,
      parentStreamId: sourceOwner,
      childStreamId,
      agent: 'claude_code',
    });
    ClaudeAgentSessions.register('foreign-session', {
      childStreamId,
      executionId: sourceExecutionId,
      executions: {
        getHandle: () => handle,
      } as any,
      model: 'claude-sonnet-4-6',
      permissionMode: 'acceptEdits',
      effort: 'high',
    });

    const result = await new ClaudeAgentTool().call({
      prompt: 'read a foreign branch',
      session_id: 'foreign-session',
      fork_session: true,
    });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('owned by a different session'),
    });
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
    ClaudeAgentSessions.release('foreign-session');
  });
});
