import { Effect } from 'effect';
// Regression coverage for atomic Codex disk-resume claims. Concurrent calls
// with the same stale thread_id must share one fallback loop: the first call
// owns asynchronous SDK setup, while later calls wait for registration and
// enqueue through the ordinary follow-up path. The detached-rejection case is
// also the only place the fresh `startThread` launch branch is exercised.

import pDefer from 'p-defer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChildRunStrategy } from '@agent/runtime/childRunLoop';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunId, StreamTabId } from '@shared/schemas';
import { codexThreadsFor } from '@tools/agentCliSessionStores';

const mocks = vi.hoisted(() => ({
  requestBashApproval: vi.fn(),
  getCurrentToolContexts: vi.fn(),
  registerExecution: vi.fn(),
  getExecutionStore: vi.fn(),
  createChildStream: vi.fn(),
  startChildRunLoop: vi.fn(),
  currentSession: vi.fn(),
  importCodexClass: vi.fn(),
  findCodexBinaryPath: vi.fn(),
  resumeThread: vi.fn(),
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
  getRunContextRunId: (ctx: any) => ctx?.executionId,
  getRunContextStreamId: (ctx: any) => ctx?.streamId,
  getRunContextWorkingDirectory: (ctx: any) => ctx?.workingDirectory,
  getRunContextInteractions: (ctx: any) => ctx?.interactions,
}));

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.currentSession,
}));

// Session-keyed registries: the suite pins one fake session and reads the
// registry that dispatch resolves for it through the same accessor.
const testSession = {
  followUps: { acquire: () => ({ enqueue: vi.fn() }) },
  // The session-keyed registry resolves live handles through its session's
  // ExecutionRegistry; this suite never tracks real handles, so lookups miss.
  executions: {
    getHandle: () => undefined,
  },
} as unknown as SessionHandle;
const CodexThreads = codexThreadsFor(testSession);

vi.mock('@agent/storage', () => ({
  registerRun: mocks.registerExecution,
  getRunStore: mocks.getExecutionStore,
}));

vi.mock('@agent/storage/executionLease', () => ({
  assertOwnedRunLease: vi.fn(),
}));

vi.mock('@tools/delegation/childStream', () => ({
  createChildRun: mocks.createChildStream,
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

vi.mock('@tools/codexConfig', () => ({
  getCodexSandboxMode: () => 'workspace-write',
  getCodexApprovalPolicy: () => 'on-request',
  getCodexCliReasoningEffort: () => 'high',
  CODEX_CLI_MODEL: 'gpt-5.2-codex',
  buildCodexConfig: () => ({
    agent: 'codex',
    model: 'Codex CLI',
    instruction: 'test',
    agentCategory: 'toolUse',
  }),
}));

vi.mock('@tools/codexImport', () => ({
  codexBinarySupportsXhigh: async () => false,
  importCodexClass: mocks.importCodexClass,
  findCodexBinaryPath: mocks.findCodexBinaryPath,
}));

import { CodexTool } from '@tools/codex';
import { createFakeAgentCliChildStream } from '../support/agentCliResumeTestUtils';

const parentStreamId = 'stream:parent' as StreamTabId;
const childStreamId = 'stream:codex-child' as StreamTabId;
const executionId = 'parent-exec' as RunId;

function completedChildRunLoop() {
  return Effect.forkDetach(Effect.void);
}

function toolContext(runContext: Record<string, unknown> = {}): unknown {
  return {
    runContext: {
      streamId: parentStreamId,
      executionId,
      workingDirectory: undefined,
      interactions: { name: 'fake-runtime-host' },
      ...runContext,
    },
    callContext: { tracker: {}, hooks: {} },
  };
}

/** Capture the strategy passed to the (single) child run loop launch. */
function captureRunLoopStrategy(): () => ChildRunStrategy<unknown> | undefined {
  let strategy: ChildRunStrategy<unknown> | undefined;
  mocks.startChildRunLoop.mockImplementation(
    (params: { strategy: ChildRunStrategy<unknown> }) => {
      strategy = params.strategy;
      return completedChildRunLoop();
    },
  );
  return () => strategy;
}

describe('codex tool - atomic resume fallback', () => {
  beforeEach(() => {
    mocks.submitFollowUp.mockReturnValue(Effect.succeed({ status: 'sent' }));
    mocks.startChildRunLoop.mockReset();
    mocks.startChildRunLoop.mockReturnValue(completedChildRunLoop());
    mocks.importCodexClass.mockReset();
    mocks.findCodexBinaryPath.mockReset();
    mocks.requestBashApproval.mockResolvedValue({ action: 'approve' });
    mocks.getCurrentToolContexts.mockReturnValue(toolContext());
    mocks.registerExecution.mockReturnValue(Effect.void);
    mocks.getExecutionStore.mockReturnValue({ write: async () => {} });
    mocks.findCodexBinaryPath.mockResolvedValue(undefined);
    mocks.createChildStream.mockReturnValue(
      Effect.succeed(createFakeAgentCliChildStream(childStreamId)),
    );
    mocks.currentSession.mockReturnValue(testSession);
  });

  afterEach(() => {
    vi.clearAllMocks();
    CodexThreads.releaseByExecutionId(executionId);
    CodexThreads.release('stale-thread');
  });

  it('logs a detached run-loop rejection from a fresh Codex thread launch', async () => {
    const childStream = createFakeAgentCliChildStream(childStreamId);
    const error = vi
      .spyOn(childStream.logger, 'error')
      .mockImplementation(() => {});
    const lateFailure = new Error('late Codex finalization failed');
    mocks.createChildStream.mockReturnValue(Effect.succeed(childStream));
    mocks.startChildRunLoop.mockReturnValue(
      Effect.forkDetach(Effect.fail(lateFailure)),
    );
    mocks.importCodexClass.mockResolvedValue(
      class MockCodex {
        startThread(): {
          id: undefined;
          runStreamed: ReturnType<typeof vi.fn>;
        } {
          return { id: undefined, runStreamed: vi.fn() };
        }
      },
    );

    await expect(
      new CodexTool().call({
        prompt: 'launch Codex',
        sandbox_mode: 'workspace-write',
      }),
    ).resolves.toMatchObject({ status: 'executed' });
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith('Codex run loop failed after launch', {
        data: lateFailure,
      });
    });
  });

  it('releases a resume reservation when launch rejects a missing run context', async () => {
    mocks.getCurrentToolContexts.mockReturnValue(undefined);

    await expect(
      new CodexTool().call({
        prompt: 'resume Codex',
        sandbox_mode: 'workspace-write',
        thread_id: 'stale-thread',
      }),
    ).resolves.toMatchObject({ status: 'error' });
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();

    const release = CodexThreads.claim('stale-thread');
    expect(release).toBeTypeOf('function');
    release?.();
  });

  it('launches one fallback loop when concurrent calls use the same stale thread_id', async () => {
    const sdkImportStarted = pDefer<void>();
    const sdkReady = pDefer<any>();
    const thread = {
      id: 'stale-thread',
      runStreamed: vi.fn(),
    };
    const executions = {
      getHandle: () => undefined,
    } as any;
    const getStrategy = captureRunLoopStrategy();

    mocks.importCodexClass.mockImplementation(() => {
      sdkImportStarted.resolve(undefined);
      return sdkReady.promise;
    });

    const tool = new CodexTool();
    const first = tool.call({
      prompt: 'continue the refactor',
      sandbox_mode: 'workspace-write',
      thread_id: 'stale-thread',
    });
    await sdkImportStarted.promise;

    const second = tool.call({
      prompt: 'also update the tests',
      sandbox_mode: 'workspace-write',
      thread_id: 'stale-thread',
    });
    await Promise.resolve();

    expect(mocks.importCodexClass).toHaveBeenCalledTimes(1);
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();

    sdkReady.resolve(
      class MockCodex {
        resumeThread(threadId: string): typeof thread {
          mocks.resumeThread(threadId);
          return thread;
        }
      },
    );
    const firstResult = await first;
    getStrategy()?.onTurnSuccess?.({}, { executions } as any);
    const secondResult = await second;

    expect(firstResult.status).toBe('executed');
    expect(secondResult.summary).toMatch(/Follow-up queued/);
    expect(mocks.resumeThread).toHaveBeenCalledOnce();
    expect(mocks.resumeThread).toHaveBeenCalledWith('stale-thread');
    expect(mocks.startChildRunLoop).toHaveBeenCalledTimes(1);
    expect(mocks.submitFollowUp).toHaveBeenCalledOnce();
    expect(mocks.submitFollowUp).toHaveBeenCalledWith(
      childStreamId,
      'also update the tests',
      expect.objectContaining({ session: expect.anything() }),
    );

    getStrategy()?.releaseSessionOwnership?.();
    expect(CodexThreads.lookup('stale-thread')).toBeUndefined();
  });
});
