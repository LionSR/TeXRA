import { strict as assert } from 'node:assert';
import { Effect } from 'effect';
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
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunId } from '@shared/schemas';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { claudeAgentSessionsFor } from '@tools/agentCliSessionStores';

const mocks = vi.hoisted(() => ({
  requestBashApproval: vi.fn(),
  getCurrentToolContexts: vi.fn(),
  registerRun: vi.fn(),
  getRunStore: vi.fn(),
  createChildRun: vi.fn(),
  startChildRunLoop: vi.fn(),
  currentSession: vi.fn(),
  query: vi.fn(),
  buildClaudeAgentEnv: vi.fn(),
  findClaudeBinaryPath: vi.fn(),
  submitFollowUp: vi.fn(),
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
  runInSession: (_session: unknown, run: () => unknown) => run(),
  getRunContextRunId: (ctx: any) => ctx?.runId,
  getRunContextWorkingDirectory: (ctx: any) => ctx?.workingDirectory,
  getRunContextInteractions: (ctx: any) => ctx?.interactions,
}));

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.currentSession,
}));

// Session-keyed registries: the suite pins one fake session and reads the
// registry that dispatch resolves for it through the same accessor.
// The session-keyed registry resolves live handles through its session's
// RunRegistry. Tests stage a handle here for the lookups they exercise;
// unset slots miss, like an untracked run.
const sessionHandles: { byRunId?: unknown } = {};
const testSession = {
  followUps: { acquire: () => ({ enqueue: vi.fn() }) },
  runs: {
    getHandle: () => sessionHandles.byRunId,
  },
} as unknown as SessionHandle;
const ClaudeAgentSessions = claudeAgentSessionsFor(testSession);

vi.mock('@agent/storage', () => ({
  registerRun: mocks.registerRun,
  getRunStore: mocks.getRunStore,
}));

vi.mock('@agent/storage/runLease', () => ({
  assertOwnedRunLease: vi.fn(),
}));

vi.mock('@tools/delegation/childRun', () => ({
  createChildRun: mocks.createChildRun,
  childRunDescription: (raw: string) => raw,
}));

vi.mock('@agent/runtime/childRunLoop', () => ({
  runWithOwnedRunLeaseLaunchGuard: (
    ...args: Parameters<
      typeof import('@agent/runtime/childRunLoop').runWithOwnedRunLeaseLaunchGuard
    >
  ) => args[2],
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

import { ClaudeAgentTool, runStreamedTurn } from '@tools/claudeAgent';
import { createFakeAgentCliChildRun } from '../support/agentCliResumeTestUtils';

const parentRunId = 'parent-run' as RunId;
const childRunId = 'claude-child-run' as RunId;

function completedChildRunLoop() {
  return Effect.forkDetach(Effect.void);
}

function stubRuns(): any {
  return {
    getHandle: () => undefined,
  };
}

function fakeToolContexts(extra: Record<string, unknown> = {}): unknown {
  return {
    runContext: {
      runId: parentRunId,
      interactions: { name: 'fake-runtime-host' },
      ...extra,
    },
    callContext: { tracker: {}, hooks: {} },
  };
}

function fakePorts(): ChildRunPorts {
  return { notify: () => {}, recordCost: () => {} };
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
    mocks.submitFollowUp.mockReturnValue(Effect.succeed({ status: 'sent' }));
    mocks.startChildRunLoop.mockReset();
    mocks.startChildRunLoop.mockReturnValue(completedChildRunLoop());
    mocks.buildClaudeAgentEnv.mockReset();
    mocks.findClaudeBinaryPath.mockReset();
    mocks.requestBashApproval.mockResolvedValue({ action: 'approve' });
    mocks.getCurrentToolContexts.mockReturnValue(fakeToolContexts());
    mocks.registerRun.mockReturnValue(Effect.void);
    mocks.getRunStore.mockReturnValue({ write: async () => {} });
    mocks.buildClaudeAgentEnv.mockReturnValue(Effect.succeed({}));
    mocks.findClaudeBinaryPath.mockResolvedValue(undefined);
    mocks.createChildRun.mockReturnValue(
      Effect.succeed(createFakeAgentCliChildRun(childRunId)),
    );
    mocks.currentSession.mockReturnValue(testSession);
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Clear anything a test registered into the real (module-level) registry.
    ClaudeAgentSessions.releaseByRunId(parentRunId);
    ClaudeAgentSessions.release('stale-session');
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
    expect(mocks.registerRun).not.toHaveBeenCalled();
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });

  it('does not create a run when Claude binary discovery fails', async () => {
    mocks.findClaudeBinaryPath.mockRejectedValue(
      new Error('Claude binary lookup failed'),
    );

    const result = await new ClaudeAgentTool().call({
      prompt: 'must not create a stale child',
    });

    expect(result.status).toBe('error');
    expect(mocks.registerRun).not.toHaveBeenCalled();
    expect(mocks.createChildRun).not.toHaveBeenCalled();
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });

  it('detaches the abort link when SDK query construction throws', async () => {
    const signal = new AbortController().signal;
    const removeEventListener = vi.spyOn(signal, 'removeEventListener');
    const failure = new Error('Claude query construction failed');
    mocks.query.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(
      runStreamedTurn({
        prompt: 'start Claude',
        logger: createFakeAgentCliChildRun(childRunId).logger,
        signal,
        model: 'claude-sonnet-4-6',
        permissionMode: 'acceptEdits',
        effort: 'high',
        cwd: undefined,
        additionalDirectories: undefined,
        env: {},
        resumeSessionId: undefined,
        pathToClaudeCodeExecutable: undefined,
      }),
    ).rejects.toBe(failure);

    expect(removeEventListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
    );
  });

  it('logs a detached run-loop rejection through the child trace', async () => {
    const childRun = createFakeAgentCliChildRun(childRunId);
    const error = vi
      .spyOn(childRun.logger, 'error')
      .mockImplementation(() => {});
    const lateFailure = new Error('late Claude finalization failed');
    mocks.createChildRun.mockReturnValue(Effect.succeed(childRun));
    mocks.startChildRunLoop.mockReturnValue(
      Effect.forkDetach(Effect.fail(lateFailure)),
    );

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
    await Effect.runPromise(
      loopParams.strategy.launch(fakePorts(), new AbortController().signal),
    );

    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [callArgs] = mocks.query.mock.calls[0] as [
      { options: { resume?: string } },
    ];
    expect(callArgs.options.resume).toBe('stale-session');
  });

  it('preserves legacy usage when a result has no modelUsage', async () => {
    const childRun = createFakeAgentCliChildRun(childRunId);
    const publishUsage = vi.spyOn(childRun.logger, 'usage');
    mocks.createChildRun.mockReturnValue(Effect.succeed(childRun));
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
    assert.ok(captured.strategy);
    const turn = await Effect.runPromise(
      captured.strategy.launch(fakePorts(), new AbortController().signal),
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
    const runs = stubRuns();
    const captured = captureStrategy();
    // The launch path generates the child's run id, and that id is both the
    // registry entry and the follow-up address, so the case reads it from the
    // child the launch created.
    let launchedRunId: RunId | undefined;
    mocks.createChildRun.mockImplementation(
      (_session: unknown, runId: RunId) => {
        launchedRunId = runId;
        return Effect.succeed(createFakeAgentCliChildRun(runId));
      },
    );
    mocks.buildClaudeAgentEnv.mockImplementation(() => {
      envStarted.resolve(undefined);
      return Effect.promise(() => envReady.promise);
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
      runs,
    } as any);
    const secondResult = await second;

    expect(firstResult.status).toBe('executed');
    expect(secondResult.summary).toMatch(/Follow-up queued/);
    expect(mocks.startChildRunLoop).toHaveBeenCalledTimes(1);
    expect(mocks.submitFollowUp).toHaveBeenCalledOnce();
    expect(mocks.submitFollowUp).toHaveBeenCalledWith(
      launchedRunId,
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

    sessionHandles.byRunId = { interrupt };
    captured.strategy?.onLoopStart?.(testSession);
    ClaudeAgentSessions.interruptAll();

    expect(interrupt).toHaveBeenCalledOnce();
    captured.strategy?.releaseSessionOwnership?.();
    delete sessionHandles.byRunId;
  });

  it('lets a waiting caller own the fallback after the first launch fails', async () => {
    const firstEnvStarted = pDefer<void>();
    const firstEnv = pDefer<NodeJS.ProcessEnv>();
    const captured = captureStrategy();
    mocks.buildClaudeAgentEnv
      .mockImplementationOnce(() => {
        firstEnvStarted.resolve(undefined);
        // A rejected env read was a rejected Promise collaborator before the
        // conversion; as an Effect with no failure channel it stays a defect,
        // so the tool still surfaces it as an error result.
        return Effect.promise(() => firstEnv.promise);
      })
      .mockReturnValueOnce(Effect.succeed({}));

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
    ClaudeAgentSessions.register('sess-resumed', { runId: childRunId });

    const result = await new ClaudeAgentTool().call({
      prompt: 'one more follow-up',
      session_id: 'sess-resumed',
    });

    expect(result.status).toBe('executed');
    expect(result.summary).toMatch(/Follow-up queued/);
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });

  it('forks an active session into a distinct child and only forks its first turn', async () => {
    ClaudeAgentSessions.register('source-session', { runId: childRunId });
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
    const ports = fakePorts();
    assert.ok(captured.strategy);
    const firstTurn = await Effect.runPromise(
      captured.strategy.launch(ports, new AbortController().signal),
    );
    if (!firstTurn) throw new Error('Expected a Claude fork turn');
    captured.strategy?.onTurnSuccess?.(firstTurn, {
      runs: stubRuns(),
    } as any);
    assert.ok(captured.strategy?.runTurn);
    await Effect.runPromise(
      captured.strategy.runTurn(
        [{ text: 'continue the fork', origin: 'user' }],
        ports,
        new AbortController().signal,
      ),
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
    expect(ClaudeAgentSessions.lookup('source-session')?.runId).toBe(
      childRunId,
    );
    expect(ClaudeAgentSessions.lookup('forked-session')).toBeDefined();
    captured.strategy?.releaseSessionOwnership?.();
    ClaudeAgentSessions.release('forked-session');
  });

  it.each([
    { caseName: 'omits the new session id', subtype: 'success' },
    {
      caseName: 'echoes the source session id',
      subtype: 'success',
      sessionId: 'source-session',
    },
    {
      caseName: 'reports an error without a new session id',
      subtype: 'error_during_execution',
    },
  ])('fails a fork that $caseName', async ({ subtype, sessionId }) => {
    ClaudeAgentSessions.register('source-session', { runId: childRunId });
    mocks.query.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'result',
          subtype,
          ...(subtype === 'success'
            ? { result: 'Malformed fork turn' }
            : { errors: ['Provider fork failure'] }),
          ...(sessionId ? { session_id: sessionId } : {}),
          usage: { input_tokens: 7, output_tokens: 3 },
          total_cost_usd: 0.25,
        };
      })(),
    );
    const captured = captureStrategy();

    const result = await new ClaudeAgentTool().call({
      prompt: 'try a different proof',
      session_id: 'source-session',
      fork_session: true,
    });

    expect(result.status).toBe('executed');
    const ports = fakePorts();
    assert.ok(captured.strategy);
    const firstTurn = await Effect.runPromise(
      captured.strategy.launch(ports, new AbortController().signal),
    );
    expect(firstTurn).toMatchObject({
      isError: true,
      usage: { input_tokens: 7, output_tokens: 3 },
      totalCostUsd: 0.25,
      errorMessage: expect.stringContaining(
        'Claude Code fork did not create a distinct session',
      ),
    });
    expect(captured.strategy?.isTurnError?.(firstTurn)).toBe(true);
    const formattedError = await captured.strategy?.formatError(
      firstTurn,
      null,
    );
    expect(formattedError).toContain('<cost-usd>0.2500</cost-usd>');

    assert.ok(captured.strategy?.runTurn);
    await Effect.runPromise(
      captured.strategy.runTurn(
        [{ text: 'must not resume the source', origin: 'user' }],
        ports,
        new AbortController().signal,
      ),
    );
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[0]?.[0]).toMatchObject({
      options: { resume: 'source-session', forkSession: true },
    });
    expect(mocks.query.mock.calls[1]?.[0].options).not.toHaveProperty('resume');
    expect(mocks.query.mock.calls[1]?.[0].options).not.toHaveProperty(
      'forkSession',
    );
  });

  it('rejects a fork from a live session owned by another run', async () => {
    const sourceRunId = 'source-run' as RunId;
    const sourceOwner = 'other-owner-run' as RunId;
    const handle = testRunHandle({
      runId: sourceRunId,
      parent: sourceOwner,
      agent: 'claude_code',
    });
    ClaudeAgentSessions.register('foreign-session', { runId: sourceRunId });
    sessionHandles.byRunId = handle;

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
    delete sessionHandles.byRunId;
  });
});
