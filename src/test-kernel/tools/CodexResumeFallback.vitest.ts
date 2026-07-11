// Regression coverage for atomic Codex disk-resume claims. Concurrent calls
// with the same stale thread_id must share one fallback loop: the first call
// owns asynchronous SDK setup, while later calls wait for registration and
// enqueue through the ordinary follow-up path.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunTrace, StreamLogStore } from '@transcript';
import type { AgentTrace } from '@agent/trace';
import type { ChildRunStrategy } from '@agent/runtime/childRunLoop';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { CodexThreads } from '@tools/agentCliSessionStores';
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
  importCodexClass: vi.fn(),
  findCodexBinaryPath: vi.fn(),
  resumeThread: vi.fn(),
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
  importCodexClass: mocks.importCodexClass,
  findCodexBinaryPath: mocks.findCodexBinaryPath,
}));

import { CodexTool } from '@tools/codex';

const parentStreamId = 'stream:parent' as StreamTabId;
const childStreamId = 'stream:codex-child' as StreamTabId;
const executionId = 'parent-exec' as ExecutionId;

function deferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
} {
  let settle: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject: (reason) => rejectPromise?.(reason),
    resolve: (value) => settle?.(value),
  };
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

describe('codex tool - atomic resume fallback', () => {
  afterEach(() => {
    vi.clearAllMocks();
    CodexThreads.releaseMany(['stale-thread']);
  });

  function setupCommonMocks(): void {
    mocks.startChildRunLoop.mockReset();
    mocks.importCodexClass.mockReset();
    mocks.findCodexBinaryPath.mockReset();
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
    mocks.findCodexBinaryPath.mockResolvedValue(undefined);
    mocks.createChildStream.mockReturnValue(fakeChildStream());
    mocks.currentSession.mockReturnValue({
      followUps: { acquire: () => ({ enqueue: mocks.enqueueFollowUp }) },
    });
  }

  it('launches one fallback loop when concurrent calls use the same stale thread_id', async () => {
    setupCommonMocks();
    const sdkImportStarted = deferred<void>();
    const sdkReady = deferred<any>();
    const thread = {
      id: 'stale-thread',
      runStreamed: vi.fn(),
    };
    const executions = { getAgentHandleByStream: () => undefined } as any;
    let strategy: ChildRunStrategy<unknown> | undefined;

    mocks.importCodexClass.mockImplementation(() => {
      sdkImportStarted.resolve(undefined);
      return sdkReady.promise;
    });
    mocks.startChildRunLoop.mockImplementation(
      (params: { strategy: ChildRunStrategy<unknown> }) => {
        strategy = params.strategy;
        params.strategy.onSessionStart?.({ executions } as any);
      },
    );

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
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe('executed');
    expect(secondResult.summary).toMatch(/Follow-up queued/);
    expect(mocks.resumeThread).toHaveBeenCalledOnce();
    expect(mocks.resumeThread).toHaveBeenCalledWith('stale-thread');
    expect(mocks.startChildRunLoop).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueFollowUp).toHaveBeenCalledOnce();
    expect(mocks.enqueueFollowUp).toHaveBeenCalledWith({
      text: 'also update the tests',
    });

    strategy?.onSessionCleanup?.();
    expect(CodexThreads.isActive('stale-thread')).toBe(false);
  });

  it('releases the fallback claim when asynchronous SDK setup fails', async () => {
    setupCommonMocks();
    mocks.importCodexClass.mockRejectedValue(new Error('SDK import failed'));

    const result = await new CodexTool().call({
      prompt: 'continue the refactor',
      sandbox_mode: 'workspace-write',
      thread_id: 'stale-thread',
    });

    expect(result.status).toBe('error');
    const releaseClaim = CodexThreads.claim('stale-thread');
    expect(releaseClaim).toBeTypeOf('function');
    releaseClaim?.();
  });

  it('lets a waiting caller own the fallback after the first launch fails', async () => {
    setupCommonMocks();
    const firstImportStarted = deferred<void>();
    const firstImport = deferred<any>();
    const thread = { id: 'stale-thread', runStreamed: vi.fn() };
    const executions = { getAgentHandleByStream: () => undefined } as any;
    let strategy: ChildRunStrategy<unknown> | undefined;
    mocks.importCodexClass
      .mockImplementationOnce(() => {
        firstImportStarted.resolve(undefined);
        return firstImport.promise;
      })
      .mockResolvedValueOnce(
        class MockCodex {
          resumeThread(): typeof thread {
            return thread;
          }
        },
      );
    mocks.startChildRunLoop.mockImplementation(
      (params: { strategy: ChildRunStrategy<unknown> }) => {
        strategy = params.strategy;
        params.strategy.onSessionStart?.({ executions } as any);
      },
    );

    const tool = new CodexTool();
    const first = tool.call({
      prompt: 'first attempt',
      sandbox_mode: 'workspace-write',
      thread_id: 'stale-thread',
    });
    await firstImportStarted.promise;
    const second = tool.call({
      prompt: 'retry from the waiter',
      sandbox_mode: 'workspace-write',
      thread_id: 'stale-thread',
    });
    await Promise.resolve();

    firstImport.reject(new Error('first SDK import failed'));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe('error');
    expect(secondResult.status).toBe('executed');
    expect(secondResult.summary).toMatch(/Launched Codex/);
    expect(mocks.importCodexClass).toHaveBeenCalledTimes(2);
    expect(mocks.startChildRunLoop).toHaveBeenCalledOnce();

    strategy?.onSessionCleanup?.();
    expect(CodexThreads.isActive('stale-thread')).toBe(false);
  });
});
