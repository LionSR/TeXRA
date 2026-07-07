// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - agent
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';

// Local imports - shared
import {
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  deliverChildRunFollowUp: vi.fn(),
  deliverTerminalChildRun: vi.fn(),
  persistChildRunReport: vi.fn(),
  persistChildRunResultMeta: vi.fn(),
  readConfig: vi.fn(),
  resumeQueuedToolUseSnapshot: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  writeResultMeta: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: vi.fn(() => ({
    readConfig: mocks.readConfig,
    writeResultMeta: mocks.writeResultMeta,
  })),
}));

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

vi.mock('@agent/runtime/resumeQueuedToolUse', () => ({
  resumeQueuedToolUseSnapshot: mocks.resumeQueuedToolUseSnapshot,
}));

vi.mock('@tools/childRunDelivery', () => ({
  deliverChildRunFollowUp: mocks.deliverChildRunFollowUp,
  deliverTerminalChildRun: mocks.deliverTerminalChildRun,
  persistChildRunReport: mocks.persistChildRunReport,
  persistChildRunResultMeta: mocks.persistChildRunResultMeta,
}));

import { SharedSubagentDeliveryRegistry } from '@tools/subagentDeliveryState';
import {
  getNativeSubagentStrategy,
  NativeSubagentStrategy,
} from '@tools/delegation/nativeSubagentStrategy';

describe('NativeSubagentStrategy', () => {
  const executionId = 'exec-1' as ExecutionId;
  const parentStreamId = 'parent-stream' as StreamTabId;
  const ownerSession = {
    tag: 'owner-session',
    executions: { addListener: vi.fn(() => vi.fn()) },
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deliverTerminalChildRun.mockResolvedValue({
      kind: 'delivered',
      report: { kind: 'persisted' },
      resultMeta: { kind: 'skipped' },
    });
    mocks.persistChildRunReport.mockResolvedValue({ kind: 'persisted' });
    mocks.persistChildRunResultMeta.mockResolvedValue({ kind: 'persisted' });
  });

  afterEach(() => {
    SharedSubagentDeliveryRegistry.finish(executionId);
  });

  it('delegates terminal delivery to the child-run delivery owner', async () => {
    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      settleSubagentCost: vi.fn(),
    });

    await expect(
      strategy.persistAndDeliverTerminal('payload', {
        agentName: 'review',
        outcome: 'completed',
        success: true,
        wallTimeMs: 1,
      }),
    ).resolves.toBe(true);

    expect(mocks.deliverTerminalChildRun).toHaveBeenCalledWith({
      executionId,
      message: 'payload',
      resultMeta: {
        agentName: 'review',
        outcome: 'completed',
        success: true,
        wallTimeMs: 1,
      },
      targetStreamId: parentStreamId,
      session: ownerSession,
      gate: expect.any(Object),
    });
  });

  it('uses the captured run handle delivery target', async () => {
    const handleParent = 'handle-parent' as StreamTabId;
    const childStream = 'child-stream' as StreamTabId;
    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      settleSubagentCost: vi.fn(),
    });
    strategy.setRunHandle(
      new AgentExecutionHandle(
        executionId,
        handleParent,
        childStream,
        'review',
        'toolUse',
        {} as never,
      ),
    );

    await expect(strategy.persistAndDeliverTerminal('payload')).resolves.toBe(
      true,
    );

    expect(mocks.deliverTerminalChildRun).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId,
        message: 'payload',
        targetStreamId: handleParent,
        session: ownerSession,
      }),
    );
  });

  it('suppresses parent delivery after the captured run handle is detached', async () => {
    const handleParent = 'handle-parent' as StreamTabId;
    const childStream = 'child-stream' as StreamTabId;
    mocks.deliverTerminalChildRun.mockResolvedValue({
      kind: 'no_target',
      report: { kind: 'persisted' },
      resultMeta: { kind: 'skipped' },
    });
    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      settleSubagentCost: vi.fn(),
    });
    const handle = new AgentExecutionHandle(
      executionId,
      handleParent,
      childStream,
      'review',
      'toolUse',
      {} as never,
    );
    strategy.setRunHandle(handle);
    handle.detach();

    await expect(strategy.persistAndDeliverTerminal('payload')).resolves.toBe(
      false,
    );

    expect(mocks.deliverTerminalChildRun).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId,
        message: 'payload',
        targetStreamId: undefined,
        session: ownerSession,
      }),
    );
  });

  it('returns false when terminal delivery is not completed', async () => {
    mocks.deliverTerminalChildRun
      .mockResolvedValueOnce({
        kind: 'dropped',
        report: { kind: 'persisted' },
        resultMeta: { kind: 'skipped' },
      })
      .mockResolvedValueOnce({
        kind: 'delivered',
        report: { kind: 'persisted' },
        resultMeta: { kind: 'skipped' },
      });
    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      settleSubagentCost: vi.fn(),
    });

    await expect(strategy.persistAndDeliverTerminal('first')).resolves.toBe(
      false,
    );
    await expect(strategy.persistAndDeliverTerminal('second')).resolves.toBe(
      true,
    );

    expect(mocks.deliverTerminalChildRun).toHaveBeenCalledTimes(2);
  });

  it('delivers progress follow-ups to the captured run handle delivery target', async () => {
    const handleParent = 'handle-parent' as StreamTabId;
    const childStream = 'child-stream' as StreamTabId;
    mocks.deliverChildRunFollowUp.mockResolvedValue({ kind: 'delivered' });
    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      settleSubagentCost: vi.fn(),
    });
    strategy.setRunHandle(
      new AgentExecutionHandle(
        executionId,
        handleParent,
        childStream,
        'review',
        'toolUse',
        {} as never,
      ),
    );

    strategy.onProgress({
      kind: 'stage',
      message: 'running',
    } as never);

    expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledWith({
      targetStreamId: handleParent,
      followUp: expect.objectContaining({ origin: 'subagent_result' }),
      session: ownerSession,
      wake: undefined,
    });
  });

  it('resumes queued follow-ups with native delivery callbacks', async () => {
    const childStream = 'child-stream' as StreamTabId;
    const runtimeHost = { emit: vi.fn() };
    const config = { agentCategory: 'toolUse' };
    const snapshot = {
      agentConfig: config,
      executionId,
      messages: [],
      streamId: childStream,
    };
    mocks.readConfig.mockResolvedValue(config);
    mocks.retrieveSessionResumeData.mockResolvedValue({
      type: 'toolUse',
      snapshot,
    });
    mocks.resumeQueuedToolUseSnapshot.mockResolvedValue(true);

    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost,
      startedAt: 0,
      settleSubagentCost: vi.fn(),
    });
    strategy.setChildStreamId(childStream);

    await expect(
      strategy.wakeQueuedFollowUp(
        { status: 'queued', reason: 'waiting' },
        {
          approvalPromptsUnavailable: true,
          runtimeUnavailableTools: ['edit_file'],
        },
      ),
    ).resolves.toEqual({ kind: 'resumed' });

    expect(mocks.retrieveSessionResumeData).toHaveBeenCalledWith(
      childStream,
      executionId,
      config,
    );
    expect(mocks.resumeQueuedToolUseSnapshot).toHaveBeenCalledWith(
      childStream,
      snapshot,
      runtimeHost,
      expect.objectContaining({
        allowWaitingResult: true,
        approvalPromptsUnavailable: true,
        parentStreamId,
        runtimeUnavailableTools: ['edit_file'],
        session: ownerSession,
        onBeforeWaiting: expect.any(Function),
        onCompleted: expect.any(Function),
        onFollowUpConsumed: expect.any(Function),
        onProgress: expect.any(Function),
        onRun: expect.any(Function),
        onRunError: expect.any(Function),
      }),
    );
  });

  it('delivers a terminal error to the orchestrator when the wake fails before resumeStream installs its callbacks (issue #7402)', async () => {
    const childStream = 'child-stream' as StreamTabId;
    mocks.readConfig.mockResolvedValue({ agentCategory: 'toolUse' });
    // Simulates `retrieveSessionResumeData` throwing for unreadable resume
    // storage (SessionResumeRetrieval.ts:110-113) — this happens inside
    // `resumeStream` *before* `resumeQueuedToolUseSnapshot` is ever called,
    // so no onError/onRunError callback for this turn is installed.
    mocks.retrieveSessionResumeData.mockRejectedValue(
      new Error('resume storage unreadable'),
    );

    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      settleSubagentCost: vi.fn(),
    });
    strategy.setChildStreamId(childStream);

    await expect(
      strategy.wakeQueuedFollowUp({ status: 'queued', reason: 'waiting' }, {}),
    ).resolves.toEqual({ kind: 'queued_resume_failed' });

    // The failure must reach the orchestrator through the same terminal
    // delivery channel a resumed turn's own onError uses — not just a log
    // line at the DelegationTools call site.
    expect(mocks.deliverTerminalChildRun).toHaveBeenCalledTimes(1);
    const [deliveredCall] = mocks.deliverTerminalChildRun.mock.calls;
    expect(deliveredCall[0]).toMatchObject({
      executionId,
      message: expect.stringContaining('resume storage unreadable'),
      targetStreamId: parentStreamId,
    });

    // Terminal delivery retires this run: a later delegate_agent resume
    // attempt must not find stale strategy/registry state.
    expect(getNativeSubagentStrategy(executionId)).toBeUndefined();
    expect(
      SharedSubagentDeliveryRegistry.getActive(executionId),
    ).toBeUndefined();
  });

  it('settles the parent usage totals with the last known cost when a wake failure has nothing else to settle from (Bugbot: wake failure locks zero cost)', async () => {
    const childStream = 'child-stream' as StreamTabId;
    mocks.readConfig.mockResolvedValue({ agentCategory: 'toolUse' });
    mocks.retrieveSessionResumeData.mockRejectedValue(
      new Error('resume storage unreadable'),
    );
    mocks.persistChildRunReport.mockResolvedValue({ kind: 'persisted' });
    mocks.deliverChildRunFollowUp.mockResolvedValue({ kind: 'delivered' });
    const settleSubagentCost = vi.fn();

    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      settleSubagentCost,
    });
    strategy.setChildStreamId(childStream);
    // Captures a cost snapshot on the suspended turn before the wake fails —
    // mirrors the same real-world sequence as the #7287 abandon() test above
    // (onBeforeWaiting always runs before a turn can suspend and later be
    // resumed/abandoned/wake-failed).
    await strategy.onBeforeWaiting('done for now', [], [], 0.0042);

    await strategy.wakeQueuedFollowUp(
      { status: 'queued', reason: 'waiting' },
      {},
    );

    // deliverSubagentError's own settle call (below, second call) carries no
    // result (the wake never reached a real turn), so without the fallback
    // the parent would only ever see a 0-cost settle. The real
    // `subagentExecution.ts` wrapper this strategy is constructed with in
    // production is itself idempotent (first call wins), so it's this first
    // call — not the second — that determines what the parent's usage totals
    // actually record.
    expect(settleSubagentCost).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ totalCostUsd: 0.0042 }),
    );
  });

  it('cleans up registry entries when the underlying execution is untracked while abandoned in WAITING', () => {
    let abandonListener: ((handle: unknown) => void) | undefined;
    const addListener = vi.fn((_id: string, cb: (handle: unknown) => void) => {
      abandonListener = cb;
      return vi.fn();
    });
    const abandonableSession = {
      tag: 'abandonable-session',
      executions: { addListener },
    } as never;

    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: abandonableSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      settleSubagentCost: vi.fn(),
    });

    expect(addListener).toHaveBeenCalledWith(executionId, expect.any(Function));
    expect(getNativeSubagentStrategy(executionId)).toBe(strategy);
    expect(SharedSubagentDeliveryRegistry.getActive(executionId)).toBeDefined();

    // A native subagent that suspends into WAITING and is never resumed and
    // never errors has no other terminal event to drive `finish()`. Simulate
    // the execution registry's abandonment signal (session teardown, or the
    // handle otherwise being untracked) firing instead.
    abandonListener?.(undefined);

    expect(getNativeSubagentStrategy(executionId)).toBeUndefined();
    expect(
      SharedSubagentDeliveryRegistry.getActive(executionId),
    ).toBeUndefined();
  });

  it('cleans up registry entries even when a resumed completion hook throws', async () => {
    const childStream = 'child-stream' as StreamTabId;
    const config = { agentCategory: 'toolUse' };
    const snapshot = {
      agentConfig: config,
      executionId,
      messages: [],
      streamId: childStream,
    };
    mocks.readConfig.mockResolvedValue(config);
    mocks.retrieveSessionResumeData.mockResolvedValue({
      type: 'toolUse',
      snapshot,
    });
    let capturedOnCompleted: ((result: unknown) => Promise<void>) | undefined;
    mocks.resumeQueuedToolUseSnapshot.mockImplementation(
      async (
        _streamId: unknown,
        _snapshot: unknown,
        _host: unknown,
        options: { onCompleted: (result: unknown) => Promise<void> },
      ) => {
        capturedOnCompleted = options.onCompleted;
        return true;
      },
    );

    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      // Throwing here simulates a completion hook (formatting/delivery)
      // failing mid-flight — the exact scenario `runFlowWithLifecycle` only
      // logs and swallows rather than propagating back to this strategy.
      settleSubagentCost: () => {
        throw new Error('settle boom');
      },
    });
    strategy.setChildStreamId(childStream);

    await strategy.wakeQueuedFollowUp(
      { status: 'queued', reason: 'waiting' },
      {},
    );
    expect(capturedOnCompleted).toBeDefined();

    await expect(
      capturedOnCompleted?.({ category: 'toolUse', outcome: 'completed' }),
    ).rejects.toThrow('settle boom');

    // Despite the throw, `finish()` must still run (moved into `finally`) so
    // a later `delegate_agent` call doesn't find stale delivery state for a
    // run that has already exited its lifecycle.
    expect(getNativeSubagentStrategy(executionId)).toBeUndefined();
    expect(
      SharedSubagentDeliveryRegistry.getActive(executionId),
    ).toBeUndefined();
  });

  it('registers a waiting-cleanup that abandons the strategy once the run confirms WAITING (issue #7287)', async () => {
    // Regression: a WAITING subagent's promise never resolves again (no
    // resume through attachPromise), so nothing else ever calls this
    // strategy's private finish() for it. Without a waiting-cleanup hook,
    // killing the suspended child left `activeNativeSubagents` (and the
    // delivery registry) pointing at a gone execution forever.
    mocks.persistChildRunReport.mockResolvedValue({ kind: 'persisted' });
    mocks.deliverChildRunFollowUp.mockResolvedValue({ kind: 'delivered' });
    const handleParent = 'handle-parent-waiting' as StreamTabId;
    const childStream = 'child-stream-waiting' as StreamTabId;
    const settleSubagentCost = vi.fn();
    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      settleSubagentCost,
    });
    const handle = new AgentExecutionHandle(
      executionId,
      handleParent,
      childStream,
      'review',
      'toolUse',
      {} as never,
    );
    strategy.setRunHandle(handle);
    strategy.setChildStreamId(childStream);
    expect(getNativeSubagentStrategy(executionId)).toBe(strategy);

    // Production calls `onBeforeWaiting` (from inside the flow) before the
    // top-level promise ever resolves — that's what registers the
    // waiting-cleanup on the *current* `runHandle` (see `resumeStream`'s
    // analogous second-suspension test below for the resumed case).
    await strategy.onBeforeWaiting('done for now', [], [], 0.02);
    strategy.attachPromise(
      Promise.resolve({
        category: 'toolUse',
        outcome: STREAM_PHASE.WAITING,
        executionId,
        streamId: childStream,
      }),
    );
    // Let attachPromise's .then()/.finally() chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Suspended, not finished: the strategy stays registered for a resume.
    expect(getNativeSubagentStrategy(executionId)).toBe(strategy);

    // Simulate ExecutionRegistry.terminate()'s waiting-cleanup fallback.
    expect(handle.runWaitingCleanup()).toBe(true);

    expect(getNativeSubagentStrategy(executionId)).toBeUndefined();
    expect(
      SharedSubagentDeliveryRegistry.getActive(executionId),
    ).toBeUndefined();
    // abandon() settles the cost snapshot captured by the last onBeforeWaiting.
    expect(settleSubagentCost).toHaveBeenCalledWith(
      expect.objectContaining({ totalCostUsd: 0.02 }),
    );
  });

  it('registers a waiting-cleanup on the resumed handle when a resumed subagent suspends at WAITING a second time (issue #7286/#7287)', async () => {
    // Regression: `resumeStream()` replaces `runHandle` with a new handle for
    // the resumed turn. Before the fix, the strategy's WAITING-cleanup was
    // only ever attached to the *initial* launch promise (`attachPromise`),
    // so stopping the child during a second (or later) suspended turn ran no
    // strategy teardown at all — the fallback below would have found nothing
    // registered on the new handle and returned `false`.
    const childStream = 'child-stream-resume-waiting' as StreamTabId;
    const runtimeHost = { emit: vi.fn() };
    const config = { agentCategory: 'toolUse' };
    const snapshot = {
      agentConfig: config,
      executionId,
      messages: [],
      streamId: childStream,
    };
    mocks.readConfig.mockResolvedValue(config);
    mocks.retrieveSessionResumeData.mockResolvedValue({
      type: 'toolUse',
      snapshot,
    });
    mocks.persistChildRunReport.mockResolvedValue({ kind: 'persisted' });
    mocks.deliverChildRunFollowUp.mockResolvedValue({ kind: 'delivered' });

    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost,
      startedAt: 0,
      settleSubagentCost: vi.fn(),
    });
    strategy.setChildStreamId(childStream);

    const resumedHandle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStream,
      'review',
      'toolUse',
      {} as never,
    );
    // Simulate the resumed run's own lifecycle: it hands the strategy a
    // brand-new handle (`onRun`), processes the queued follow-up, and then
    // suspends at WAITING again (`onBeforeWaiting`) before resolving.
    mocks.resumeQueuedToolUseSnapshot.mockImplementation(
      async (_streamId, _snapshot, _host, options) => {
        options.onRun(resumedHandle);
        await options.onBeforeWaiting('resumed then waited again', [], []);
        return true;
      },
    );

    await expect(
      strategy.wakeQueuedFollowUp({ status: 'queued', reason: 'waiting' }, {}),
    ).resolves.toEqual({ kind: 'resumed' });

    // The strategy is still tracked — this second suspension hasn't been
    // torn down yet, only observed.
    expect(getNativeSubagentStrategy(executionId)).toBe(strategy);

    // The core fix: the *new* (resumed) handle — not the original launch
    // handle — has its own waiting-cleanup registered.
    expect(resumedHandle.runWaitingCleanup()).toBe(true);

    expect(getNativeSubagentStrategy(executionId)).toBeUndefined();
    expect(
      SharedSubagentDeliveryRegistry.getActive(executionId),
    ).toBeUndefined();
  });
});
