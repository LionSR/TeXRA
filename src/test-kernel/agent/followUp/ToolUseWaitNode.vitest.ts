import '@test/support/defaultSessionTestSetup';

import { DEFAULT_MODEL_CAPABILITIES } from 'llm-zoo';
import { describe, expect, it, vi } from 'vitest';

import { TraceEmitter, type AgentTrace } from '@agent/trace';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { createToolPolicy } from '@agent/core/flows/BaseFlowServices';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ToolUseWaitNode } from '@agent/implementations/flows/tooluse/nodes/ToolUseWaitNode';
import {
  extractTouchedFiles,
  type ToolUseRunShared,
  type WaitExecResult,
} from '@agent/implementations/flows/tooluse/nodes/types';
import type { ToolUseServices } from '@agent/implementations/flows/tooluse/ToolUseServices';
import type { RunModelHandler } from '@agent/runtime/ModelCell';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import { MESSAGE_TYPES, RUN_PHASE, type RunId } from '@shared/schemas';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  clearRunStatusForTest,
  seedRunStatusForTest,
} from '@test/support/runStatusTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import { releaseRunResources } from '@tools/approval';
import { GoalStore } from '@tools/goal';
import { generateRunId } from '@utils/core';

import {
  eventsOfType,
  recordSessionEvents,
  recordTraceEvents,
  sessionWithInteractions,
  traceEventsOfType,
  testRunScope,
  toolUseRunShared,
  withTestRunContext,
} from '../progressTestUtils';
import { testModelCell } from '../modelCellTestUtils';

type WaitNodeModelHandlerOverrides = Omit<
  Partial<RunModelHandler>,
  'capabilities'
> & {
  capabilities?: Partial<RunModelHandler['capabilities']>;
};

type WaitNodeServiceOverrides = Partial<
  Pick<ToolUseServices, 'parentRunId' | 'onFollowUpConsumed' | 'onIdle'>
> & {
  fileService?: Partial<ToolUseServices['fileService']>;
  logger?: AgentTrace;
  modelHandler?: WaitNodeModelHandlerOverrides;
  session?: Partial<ToolUseServices['session']>;
  /** Run identity the node reads off `services.runScope`. */
  runId?: RunId;
  /** Session owning this run's status machine and approvals. */
  ownerSession?: SessionHandle;
  signal?: AbortSignal;
  /** Injected tool policy the wait node reads instead of the ambient RunContext. */
  stopAfterCycle?: boolean;
};

function createWaitNodeServices(
  overrides: WaitNodeServiceOverrides = {},
): ToolUseServices {
  const {
    fileService,
    modelHandler,
    ownerSession,
    session,
    signal,
    stopAfterCycle,
    runId = generateRunId(),
    ...topLevel
  } = overrides;
  const { capabilities, ...modelHandlerOverrides } = modelHandler ?? {};
  const runScope = testRunScope(runId, { session: ownerSession, signal });
  publishTestRunStart(runScope.session, runScope.runId);
  return {
    runScope,
    toolPolicy: createToolPolicy({ stopAfterCycle }),
    fileService: {
      createLocation: (filePath: string) => ({ absolutePath: filePath }),
      ...fileService,
    },
    logger: new TraceEmitter(),
    modelCell: testModelCell({
      capabilities: {
        ...DEFAULT_MODEL_CAPABILITIES,
        ...capabilities,
      },
      createUserFollowUpMessages: vi.fn(async () => []),
      ...modelHandlerOverrides,
    }),
    session: {
      hasQueuedFollowUp: () => false,
      waitForFollowUp: vi.fn(async () => null),
      noteParkedWaitCancelled: vi.fn(),
      ...session,
    },
    ...topLevel,
  } as unknown as ToolUseServices;
}

function waitPrep(afterError = false) {
  return { afterError, lastResponse: undefined };
}

/** Follow-up mock that appends each text to the running message list. */
function appendUserFollowUpMessages() {
  return vi.fn(
    async (
      messages: ProviderMessage[],
      userMessage: string,
    ): Promise<ProviderMessage[]> => [
      ...messages,
      { role: 'user', content: userMessage },
    ],
  );
}

/** Follow-up mock that returns each text as a standalone user message. */
function singleUserFollowUpMessage() {
  return vi.fn(
    async (
      _messages: ProviderMessage[],
      text: string,
    ): Promise<ProviderMessage[]> => [{ role: 'user', content: text }],
  );
}

/**
 * Starts a goal whose latest cycle failed, with an owner session recording
 * approval bypass-state changes.
 */
async function startErroredGoal(
  runId: RunId,
  goal: string,
  errorMessage: string,
): Promise<{
  shared: ToolUseRunShared;
  setApprovalBypassState: ReturnType<typeof vi.fn>;
  ownerSession: SessionHandle;
}> {
  await installPlatform();
  await GoalStore.start(runId, goal);
  const shared = toolUseRunShared();
  shared.lastError = { message: errorMessage, userRetryable: false };
  const setApprovalBypassState = vi.fn();
  const ownerSession = sessionWithInteractions({
    setApprovalBypassState,
    cancel: vi.fn(),
  });
  return { shared, setApprovalBypassState, ownerSession };
}

describe('ToolUseWaitNode', () => {
  it.each([false, true] as const)(
    'always suspends a subagent cycle at WAITING (queued follow-up: %s)',
    async (hasQueuedFollowUp) => {
      // Subagent mode suspends unconditionally and symmetrically. A follow-up
      // already queued is the child-run loop's concern (it resumes immediately
      // instead of genuinely waiting), and the node never blocks on
      // session.waitForFollowUp — the loop owns the next-turn wait.
      const shared = toolUseRunShared();
      const waitForFollowUp = vi.fn();

      const services = createWaitNodeServices({
        parentRunId: generateRunId(),
        session: {
          ...(hasQueuedFollowUp ? { hasQueuedFollowUp: () => true } : {}),
          waitForFollowUp,
        },
      });

      const node = new ToolUseWaitNode().setServices(services);
      const prep = await node.prep(shared);

      const transition = await withTestRunContext(
        services.runScope,
        async () => {
          const exec = await node.exec(prep);
          expect(exec.kind).toBe('waiting');
          return node.post(shared, prep, exec);
        },
      );

      expect(transition).toBe(FlowTransition.WAITING);
      expect(waitForFollowUp).not.toHaveBeenCalled();
    },
  );

  it('advances a drained child-loop batch once without reading the session queue', async () => {
    const shared = toolUseRunShared();
    const waitForFollowUp = vi.fn();
    const createUserFollowUpMessages = singleUserFollowUpMessage();
    const onFollowUpConsumed = vi.fn();
    const batch = [
      {
        text: 'state where finiteness is used',
        displayText: 'clarify finiteness',
        origin: 'user' as const,
      },
    ];
    const services = createWaitNodeServices({
      parentRunId: generateRunId(),
      modelHandler: {
        createUserFollowUpMessages,
      },
      onFollowUpConsumed,
      session: {
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode(batch).setServices(services);
    const prep = await node.prep(shared);

    const first = await withTestRunContext(services.runScope, async () => {
      const exec = await node.exec(prep);
      const transition = await node.post(shared, prep, exec);
      return { exec, transition };
    });
    const second = await withTestRunContext(services.runScope, () =>
      node.exec(prep),
    );

    expect(first).toEqual({
      exec: {
        kind: 'continue',
        followUps: batch,
        synthetic: false,
      },
      transition: FlowTransition.CONTINUE,
    });
    expect(second).toEqual({ kind: 'waiting' });
    expect(createUserFollowUpMessages).toHaveBeenCalledOnce();
    expect(createUserFollowUpMessages).toHaveBeenCalledWith(
      [],
      'state where finiteness is used',
    );
    expect(shared.messages).toEqual([
      { role: 'user', content: 'state where finiteness is used' },
    ]);
    expect(onFollowUpConsumed).toHaveBeenCalledOnce();
    expect(waitForFollowUp).not.toHaveBeenCalled();
  });

  it('stops instead of suspending when stopAfterCycle is set (headless in-band subagent)', async () => {
    const shared = toolUseRunShared();

    // `stopAfterCycle` is injected through `services.toolPolicy`; no
    // AsyncLocalStorage frame is installed for this cycle.
    const services = createWaitNodeServices({
      parentRunId: generateRunId(),
      stopAfterCycle: true,
    });

    const node = new ToolUseWaitNode().setServices(services);
    const prep = await node.prep(shared);
    const exec = await node.exec(prep);
    expect(exec.kind).toBe('stop');
    const transition = await node.post(shared, prep, exec);

    expect(transition).toBe(FlowTransition.COMPLETE);
  });

  it('stops immediately on interruption instead of suspending a subagent', async () => {
    const shared = toolUseRunShared();

    const services = createWaitNodeServices({
      signal: AbortSignal.abort(),
      parentRunId: generateRunId(),
    });

    const node = new ToolUseWaitNode().setServices(services);

    const prep = await node.prep(shared);
    const transition = await withTestRunContext(services.runScope, async () => {
      const exec = await node.exec(prep);
      return node.post(shared, prep, exec);
    });

    expect(transition).toBe(FlowTransition.COMPLETE);
  });

  it('fires the root-only onIdle notification every cycle without suspending', async () => {
    const shared = toolUseRunShared({
      messages: [{ role: 'assistant', content: 'partial response' } as never],
    });
    const onIdle = vi.fn();
    const waitForFollowUp = vi.fn(async () => null);

    const services = createWaitNodeServices({
      onIdle,
      session: { waitForFollowUp },
    });

    const node = new ToolUseWaitNode().setServices(services);
    const prep = await node.prep(shared);
    await withTestRunContext(services.runScope, () => node.exec(prep));

    expect(onIdle).toHaveBeenCalledOnce();
    expect(waitForFollowUp).toHaveBeenCalledOnce();
  });

  it('warns when follow-up media cannot be attached to a non-vision model', async () => {
    const shared = toolUseRunShared();
    const info = vi.fn();
    const warn = vi.fn();
    const addMediaToUserMessage = vi.fn(async () => []);
    const logger = Object.assign(new TraceEmitter(), { info, warn });

    const services = createWaitNodeServices({
      logger,
      modelHandler: {
        addMediaToUserMessage,
        capabilities: {
          supportsNativeAudio: true,
          supportsVision: false,
        },
        createUserFollowUpMessages: vi.fn(async () => []),
      },
    });

    const node = new ToolUseWaitNode().setServices(services);
    const transition = await withTestRunContext(services.runScope, () =>
      node.post(shared, waitPrep(), {
        followUps: [
          {
            text: 'please inspect this figure',
            mediaFiles: ['/tmp/figure.png'],
            origin: 'user',
          },
        ],
        kind: 'continue',
      }),
    );

    expect(transition).toBe(FlowTransition.CONTINUE);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Model has no vision support'),
    );
    expect(addMediaToUserMessage).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      'please inspect this figure',
      expect.not.objectContaining({
        data: expect.objectContaining({ attachments: expect.anything() }),
      }),
    );
  });

  it('logs follow-up markers reported by provider insertion', async () => {
    const shared = toolUseRunShared();
    const info = vi.fn();
    const logger = Object.assign(new TraceEmitter(), {
      info,
      warn: vi.fn(),
    });

    const services = createWaitNodeServices({
      logger,
      modelHandler: {
        addMediaToUserMessage: vi.fn(async () => ['image' as const]),
        capabilities: {
          supportsNativeAudio: false,
          supportsVision: true,
        },
        createUserFollowUpMessages: vi.fn(async () => []),
      },
    });

    const node = new ToolUseWaitNode().setServices(services);
    await withTestRunContext(services.runScope, () =>
      node.post(shared, waitPrep(), {
        followUps: [
          {
            text: 'please inspect this figure',
            mediaFiles: ['/tmp/figure.png', '/tmp/missing.pdf'],
            origin: 'user',
          },
        ],
        kind: 'continue',
      }),
    );

    expect(info).toHaveBeenCalledWith('please inspect this figure', {
      messageType: MESSAGE_TYPES.USER_MESSAGE,
      data: { attachments: ['image'] },
    });
  });

  it('pauses the goal after a failed parent cycle', async () => {
    const runId = generateRunId();
    const { shared, setApprovalBypassState, ownerSession } =
      await startErroredGoal(runId, 'finish the refactor', 'cycle failed');

    const logger = new TraceEmitter();
    const recorded = recordTraceEvents(logger);
    const waitForFollowUp = vi.fn();
    const services = createWaitNodeServices({
      logger,
      ownerSession,
      runId,
      stopAfterCycle: true,
      session: {
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      // No AsyncLocalStorage frame: `pauseActiveGoal` clears every possible
      // goal bypass through `services.runScope.session` (the owner session),
      // never through `currentSession()`/`defaultSession()`.
      const exec = await node.exec(waitPrep(true));

      const goal = GoalStore.getForRun(runId);
      expect(exec.kind).toBe('stop');
      expect(waitForFollowUp).not.toHaveBeenCalled();
      expect(goal?.status).toBe('paused');
      expect(traceEventsOfType(recorded.events, 'goalPaused')).toContainEqual(
        expect.objectContaining({
          runId,
        }),
      );
      expect(setApprovalBypassState).toHaveBeenCalledWith({
        runId,
        kind: 'bash',
        bypassActive: false,
      });
      expect(setApprovalBypassState).toHaveBeenCalledWith({
        runId,
        kind: 'toolEdit',
        bypassActive: false,
      });
      expect(setApprovalBypassState).toHaveBeenCalledWith({
        runId,
        kind: 'superYolo',
        bypassActive: false,
      });
    } finally {
      await GoalStore.forget(runId);
      releaseRunResources(runId);
    }
  });

  it('injects an active goal continuation before the blocking wait', async () => {
    const runId = generateRunId();
    await installPlatform();

    await GoalStore.start(runId, 'Finish the autonomous proof audit.');

    const shared = toolUseRunShared();
    const createUserFollowUpMessages = appendUserFollowUpMessages();
    const onFollowUpConsumed = vi.fn();
    const waitForFollowUp = vi.fn();
    const ownerSession = sessionWithInteractions(undefined);
    const runStatus = ownerSession.status;
    const services = createWaitNodeServices({
      modelHandler: {
        createUserFollowUpMessages,
      },
      onFollowUpConsumed,
      ownerSession,
      runId,
      session: {
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
      });
      const prep = await node.prep(shared);
      const exec = await withTestRunContext(services.runScope, () =>
        node.exec(prep),
      );

      expect(exec.kind).toBe('continue');
      if (exec.kind !== 'continue') return;
      expect(exec.synthetic).toBe(true);
      expect(exec.followUps).toEqual([
        {
          text: expect.stringContaining('Finish the autonomous proof audit.'),
          origin: 'synthetic',
        },
      ]);
      expect(waitForFollowUp).not.toHaveBeenCalled();
      expect(runStatus.get(runId)).toBe(RUN_PHASE.RUNNING);

      const transition = await withTestRunContext(services.runScope, () =>
        node.post(shared, prep, exec),
      );

      expect(transition).toBe(FlowTransition.CONTINUE);
      expect(onFollowUpConsumed).not.toHaveBeenCalled();
      expect(createUserFollowUpMessages).toHaveBeenCalledOnce();
      expect(createUserFollowUpMessages).toHaveBeenCalledWith(
        [],
        expect.stringContaining('<goal_context>'),
      );
      expect(shared.messages).toEqual([
        {
          role: 'user',
          content: expect.stringContaining(
            'Finish the autonomous proof audit.',
          ),
        },
      ]);
      expect(runStatus.get(runId)).toBe(RUN_PHASE.RUNNING);
    } finally {
      await GoalStore.forget(runId);
    }
  });

  it('lets queued user follow-up win over an active goal continuation', async () => {
    const runId = generateRunId();
    await installPlatform();

    await GoalStore.start(runId, 'Keep going autonomously.');

    const waitForFollowUp = vi.fn(async () => ({
      items: [{ text: 'user correction', origin: 'user' as const }],
      synthetic: false,
    }));
    const services = createWaitNodeServices({
      runId,
      session: {
        hasQueuedFollowUp: () => true,
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      const exec = await withTestRunContext(services.runScope, () =>
        node.exec(waitPrep()),
      );

      expect(waitForFollowUp).toHaveBeenCalledOnce();
      expect(exec).toEqual({
        kind: 'continue',
        followUps: [{ text: 'user correction', origin: 'user' }],
        synthetic: false,
      });
    } finally {
      await GoalStore.forget(runId);
    }
  });

  it('updates the run session status while waiting and resuming', async () => {
    const runId = generateRunId();
    const ownerSession = sessionWithInteractions(undefined);
    const runStatus = ownerSession.status;
    const shared = toolUseRunShared();
    const createUserFollowUpMessages = vi.fn(async () => []);
    const services = createWaitNodeServices({
      ownerSession,
      runId,
      modelHandler: {
        createUserFollowUpMessages,
      },
      session: {
        waitForFollowUp: async () => ({
          items: [{ text: 'continue', origin: 'synthetic' }],
          synthetic: true,
        }),
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.RUNNING,
      });

      const prep = await node.prep(shared);
      const exec = await withTestRunContext(services.runScope, () =>
        node.exec(prep),
      );
      expect(runStatus.get(runId)).toBe(RUN_PHASE.WAITING);

      await withTestRunContext(services.runScope, () =>
        node.post(shared, prep, exec),
      );
      expect(runStatus.get(runId)).toBe(RUN_PHASE.RUNNING);
      expect(createUserFollowUpMessages).toHaveBeenCalledOnce();
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('repairs retry-cancelled parent cycles to waiting before blocking', async () => {
    const runId = generateRunId();
    const ownerSession = sessionWithInteractions(undefined);
    const runStatus = ownerSession.status;
    // Status is a session fact on the session's plane, the single rail.
    const recorded = recordSessionEvents(ownerSession);
    const waitForFollowUp = vi.fn(async () => null);
    const services = createWaitNodeServices({
      ownerSession,
      runId,
      session: {
        waitForFollowUp,
      },
    });
    const node = new ToolUseWaitNode().setServices(services);

    try {
      seedRunStatusForTest(runStatus, runId, {
        phase: RUN_PHASE.CANCELLED,
      });

      const exec = await withTestRunContext(services.runScope, () =>
        node.exec(waitPrep(true)),
      );

      expect(exec.kind).toBe('stop');
      expect(waitForFollowUp).toHaveBeenCalledOnce();
      expect(runStatus.get(runId)).toBe(RUN_PHASE.WAITING);
      expect(eventsOfType(await recorded.read(), 'status')).toEqual([
        expect.objectContaining({
          phase: RUN_PHASE.RUNNING,
          previousPhase: RUN_PHASE.CANCELLED,
          cause: 'resume',
        }),
        expect.objectContaining({
          phase: RUN_PHASE.WAITING,
          previousPhase: RUN_PHASE.RUNNING,
          cause: 'wait',
        }),
      ]);
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
  });

  it('appends queued subagent results and user follow-ups as separate turns', async () => {
    const shared = toolUseRunShared({
      stateSlices: {
        runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
        workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
        userChannels: { INSTRUCTION: 'initial request' },
      },
    });
    const createUserFollowUpMessages = appendUserFollowUpMessages();
    const info = vi.fn(() => {
      expect(ownerSession.status.get(runId)).toBe(RUN_PHASE.RUNNING);
    });
    const runId = generateRunId();
    const logger = Object.assign(new TraceEmitter(), {
      error: vi.fn(),
      info,
    });
    const ownerSession = sessionWithInteractions(undefined);
    const recorded = recordSessionEvents(ownerSession);
    const runStatus = ownerSession.status;
    const services = createWaitNodeServices({
      logger,
      modelHandler: {
        capabilities: { supportsVision: true },
        createUserFollowUpMessages,
      },
      ownerSession,
      runId,
      session: {
        hasQueuedFollowUp: () => true,
        waitForFollowUp: async () => ({
          items: [
            {
              text: '<subagent-result>done</subagent-result>',
              origin: 'subagent_result',
            },
            {
              text: 'please revise the theorem',
              origin: 'user',
            },
          ],
          synthetic: false,
        }),
      },
    });
    const node = new ToolUseWaitNode().setServices(services);
    seedRunStatusForTest(runStatus, runId, {
      phase: RUN_PHASE.WAITING,
    });

    const prep = await node.prep(shared);
    try {
      const transition = await withTestRunContext(
        services.runScope,
        async () => {
          const exec = await node.exec(prep);
          return node.post(shared, prep, exec);
        },
      );

      expect(transition).toBe(FlowTransition.CONTINUE);
      expect(ownerSession.status.get(runId)).toBe(RUN_PHASE.RUNNING);
      expect(info).toHaveBeenCalled();
    } finally {
      clearRunStatusForTest(runStatus, runId);
    }
    expect(createUserFollowUpMessages).toHaveBeenNthCalledWith(
      1,
      [],
      '<subagent-result>done</subagent-result>',
    );
    expect(createUserFollowUpMessages).toHaveBeenNthCalledWith(
      2,
      [{ role: 'user', content: '<subagent-result>done</subagent-result>' }],
      'please revise the theorem',
    );
    expect(shared.messages).toEqual([
      { role: 'user', content: '<subagent-result>done</subagent-result>' },
      { role: 'user', content: 'please revise the theorem' },
    ]);
    expect(info).toHaveBeenCalledWith('✓ subagent completed', {
      messageType: MESSAGE_TYPES.USER_MESSAGE,
    });
    expect(info).toHaveBeenCalledWith('please revise the theorem', {
      messageType: MESSAGE_TYPES.USER_MESSAGE,
    });
    expect(shared.stateSlices?.userChannels.INSTRUCTION).toBe(
      'please revise the theorem',
    );
  });

  // Regression #9443: a drained batch is consumed before the subagent
  // after-error stop, so user input the child-run loop already took off the
  // queue reaches the model and `post` clears the error. Since consuming the
  // batch continues immediately, an active goal must not be paused or lose its
  // unattended bash approval first.
  it('recovers an errored goal from a drained batch without pausing it', async () => {
    const runId = generateRunId();
    const { shared, setApprovalBypassState, ownerSession } =
      await startErroredGoal(
        runId,
        'finish the autonomous proof',
        'stale failure from the previous cycle',
      );

    const batch = [{ text: 'try the other lemma', origin: 'user' as const }];
    const services = createWaitNodeServices({
      parentRunId: generateRunId(),
      ownerSession,
      runId,
      modelHandler: {
        createUserFollowUpMessages: singleUserFollowUpMessage(),
      },
    });
    const node = new ToolUseWaitNode(batch).setServices(services);

    try {
      const prep = await node.prep(shared);
      expect(prep.afterError).toBe(true);

      const { exec, transition } = await withTestRunContext(
        services.runScope,
        async () => {
          const exec = await node.exec(prep);
          return { exec, transition: await node.post(shared, prep, exec) };
        },
      );

      expect(exec).toEqual({
        kind: 'continue',
        followUps: batch,
        synthetic: false,
      });
      expect(transition).toBe(FlowTransition.CONTINUE);
      // Consuming the batch recovers the error rather than stranding it.
      expect(shared.lastError).toBeUndefined();
      expect(GoalStore.getForRun(runId)?.status).toBe('active');
      expect(setApprovalBypassState).not.toHaveBeenCalled();
    } finally {
      await GoalStore.forget(runId);
      releaseRunResources(runId);
    }
  });

  it('pauses an errored goal when a drained recovery batch cannot be applied', async () => {
    const runId = generateRunId();
    const { shared, setApprovalBypassState, ownerSession } =
      await startErroredGoal(
        runId,
        'finish the autonomous proof',
        'stale failure from the previous cycle',
      );

    const applicationError = new Error('follow-up media is unreadable');
    const batch = [{ text: 'use this diagram', origin: 'user' as const }];
    const services = createWaitNodeServices({
      parentRunId: generateRunId(),
      ownerSession,
      runId,
      modelHandler: {
        createUserFollowUpMessages: vi.fn(async () => {
          throw applicationError;
        }),
      },
    });
    const node = new ToolUseWaitNode(batch).setServices(services);

    try {
      const prep = await node.prep(shared);
      const exec = await withTestRunContext(services.runScope, () =>
        node.exec(prep),
      );

      await expect(
        withTestRunContext(services.runScope, () =>
          node.post(shared, prep, exec),
        ),
      ).rejects.toBe(applicationError);

      expect(shared.lastError).toEqual({
        message: 'stale failure from the previous cycle',
        userRetryable: false,
      });
      expect(GoalStore.getForRun(runId)?.status).toBe('paused');
      expect(setApprovalBypassState).toHaveBeenCalledWith({
        runId,
        kind: 'bash',
        bypassActive: false,
      });
    } finally {
      await GoalStore.forget(runId);
      releaseRunResources(runId);
    }
  });

  // Companion to the above: with no drained batch in hand, the after-error
  // stop must still fire, or a subagent would wait for a follow-up its
  // orchestrator was never told to send.
  it('still stops a subagent after an error when no batch was drained', async () => {
    const shared = toolUseRunShared();
    shared.lastError = { message: 'boom', userRetryable: false };
    const waitForFollowUp = vi.fn();
    const services = createWaitNodeServices({
      parentRunId: generateRunId(),
      session: { waitForFollowUp },
    });
    const node = new ToolUseWaitNode().setServices(services);

    const prep = await node.prep(shared);
    const exec = await withTestRunContext(services.runScope, () =>
      node.exec(prep),
    );

    expect(exec).toEqual({ kind: 'stop' });
    expect(waitForFollowUp).not.toHaveBeenCalled();
  });
});

describe('ToolUseWaitNode follow-up transcript logging (regression: #7508 pattern on resume)', () => {
  function transcriptLogServices(
    overrides: WaitNodeServiceOverrides = {},
  ): ToolUseServices {
    return createWaitNodeServices({
      logger: Object.assign(new TraceEmitter(), {
        info: vi.fn(),
        warn: vi.fn(),
      }),
      modelHandler: {
        createUserFollowUpMessages: vi.fn(
          async (messages: ProviderMessage[]) => messages,
        ),
      },
      ...overrides,
    });
  }

  function userFollowUp(): WaitExecResult {
    return {
      kind: 'continue',
      followUps: [{ text: 'Do the thing.', origin: 'user' }],
    };
  }

  function failAppend(services: ToolUseServices, message: string): void {
    (
      services.modelCell.handler.createUserFollowUpMessages as ReturnType<
        typeof vi.fn
      >
    ).mockRejectedValue(new Error(message));
  }

  function runPost(
    services: ToolUseServices,
    execRes: WaitExecResult,
  ): Promise<unknown> {
    const node = new ToolUseWaitNode().setServices(services);
    const shared = toolUseRunShared();
    return withTestRunContext(services.runScope, () =>
      node.post(shared, waitPrep(), execRes),
    );
  }

  async function runPostWithFailedAppend(
    services: ToolUseServices,
    message: string,
    execRes: WaitExecResult = userFollowUp(),
  ): Promise<void> {
    failAppend(services, message);
    await expect(runPost(services, execRes)).rejects.toThrow(message);
  }

  it('logs a follow-up transcript row even when appendFollowUpAsUserMessage throws', async () => {
    // A failed follow-up append on resume (corrupt/oversized media, provider
    // validation error, ...) must still leave a record of what the user
    // asked for — otherwise that turn's transcript row silently vanishes.
    const services = transcriptLogServices();
    await runPostWithFailedAppend(services, 'follow-up append failed');

    expect(services.logger.info).toHaveBeenCalledWith(
      'Do the thing.',
      expect.objectContaining({ messageType: expect.any(String) }),
    );
  });

  it('does not acknowledge consumption when the append throws', async () => {
    // The resume wrapper restores an unacknowledged drained batch; firing
    // onFollowUpConsumed before a failing append would mark the lost input
    // as consumed and drop it instead of replaying it on the next resume.
    const onFollowUpConsumed = vi.fn();
    const services = transcriptLogServices({ onFollowUpConsumed });
    await runPostWithFailedAppend(services, 'follow-up append failed');

    expect(onFollowUpConsumed).not.toHaveBeenCalled();
  });

  it('logs a workflow delivery with its typed summary beside the collapsed text', async () => {
    // The delivery envelope carries the summary typed at the write site; the
    // transcript row producer parses it once and attaches it structured, so
    // renderers never re-extract it from the row text.
    const summary = {
      name: 'proofread-pipeline',
      outcome: 'completed',
      phaseCount: 1,
      taskDone: 2,
      taskTotal: 2,
      costUsd: 0.19,
      durationMs: 5_000,
      files: [{ path: 'paper.tex', added: 12, removed: 8 }],
      scriptPath: '.texra/workflow-scripts/proofread-pipeline.mjs',
      errorCause: null,
    };
    const escaped = JSON.stringify(summary).replaceAll('"', '&quot;');
    const text = [
      '<workflow-script-result id="abc">',
      '<response>raw run log</response>',
      `<workflow-summary>${escaped}</workflow-summary>`,
      '</workflow-script-result>',
    ].join('\n');
    const services = transcriptLogServices();

    await runPost(services, {
      kind: 'continue',
      followUps: [{ text, origin: 'subagent_result' }],
    });

    expect(services.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('✓ proofread-pipeline completed'),
      expect.objectContaining({ data: { workflowSummary: summary } }),
    );
  });

  it('does not log synthetic (idle-continuation) follow-ups', async () => {
    const services = transcriptLogServices();

    await runPostWithFailedAppend(services, 'boom', {
      kind: 'continue',
      followUps: [{ text: 'synthesized', origin: 'user' }],
      synthetic: true,
    });

    expect(services.logger.info).not.toHaveBeenCalled();
  });
});
