// Unit tests for the chat-session controller's state transitions.
// Does not require actual agent execution — the controller's orchestration
// methods (startRootRun, resume) touch real agent runtime infrastructure,
// so these tests focus on the pure predicate delegation, the factory
// contract, and the stop/idle state mutations that are safe to verify
// without a full agent harness.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getToolUseFlowContext: vi.fn(),
  kill: vi.fn(),
  notifyFollowUpSent: vi.fn(),
  sendFollowUp: vi.fn(),
  stopAgentStream: vi.fn(),
  workspaceGet: vi.fn(),
}));

vi.mock('@agent/runtime/executionRegistry', () => ({
  executionRegistry: {
    stopAgentStream: mocks.stopAgentStream,
  },
}));

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  notifyFollowUpSent: mocks.notifyFollowUpSent,
  sendFollowUp: mocks.sendFollowUp,
}));

vi.mock('@platform/platform', () => ({
  tryPlatform: () => ({
    workspaceState: {
      get: mocks.workspaceGet,
    },
  }),
}));

import { StreamSnapshotStore } from '@transcript';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { ChatSessionControllerInit } from '@cli/chat/chatSessionController';
import {
  buildInitialChatAgentConfig,
  createChatSessionController,
} from '@cli/chat/chatSessionController';
import {
  chatTuiCanStartRootRun,
  type TuiSession,
} from '@cli/chat/tui/state/sessionRunState';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<TuiSession> = {}): TuiSession {
  return {
    streamId: undefined,
    executionId: undefined,
    runtimeHost: undefined,
    runPromise: undefined,
    runExitCode: CliExitCode.Success,
    runCompleted: false,
    stopRequested: false,
    ...overrides,
  };
}

function makeSessionContext(): CliContext {
  return {
    cwd: '/tmp/test',
    mode: 'interactive',
    outputFormat: 'text',
    approvalPolicy: 'ask',
    stdoutIsTty: true,
    stderrIsTty: true,
    stdoutColorEnabled: true,
    stderrColorEnabled: true,
    quietLogs: true,
    helperModel: 'test-model',
    commandName: 'chat',
    apiMode: 'included',
  } as CliContext;
}

function makeRuntimeSession(): SessionHandle {
  return {
    executions: {
      getToolUseFlowContext: mocks.getToolUseFlowContext,
      kill: mocks.kill,
      stopAgentStream: mocks.stopAgentStream,
    },
  } as unknown as SessionHandle;
}

function makeInit(
  overrides: Partial<ChatSessionControllerInit> = {},
): ChatSessionControllerInit {
  return {
    session: makeSession(),
    getSessionContext: () => makeSessionContext(),
    disposers: [],
    snapshotStore: new StreamSnapshotStore(),
    runtimeSession: makeRuntimeSession(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Predicate: chatTuiCanStartRootRun
// ---------------------------------------------------------------------------

describe('chatTuiCanStartRootRun', () => {
  it('allows a new root run when no run has ever been started', () => {
    expect(chatTuiCanStartRootRun(makeSession())).toBe(true);
  });

  it('allows a new root run after a prior run has completed', () => {
    expect(
      chatTuiCanStartRootRun(
        makeSession({
          runPromise: Promise.resolve(),
          runCompleted: true,
        }),
      ),
    ).toBe(true);
  });

  it('disallows a new root run while a run is pending', () => {
    expect(
      chatTuiCanStartRootRun(
        makeSession({
          runPromise: new Promise(() => {}), // never settles
          runCompleted: false,
        }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Factory: createChatSessionController
// ---------------------------------------------------------------------------

describe('createChatSessionController', () => {
  beforeEach(() => {
    mocks.getToolUseFlowContext.mockReset();
    mocks.kill.mockReset();
    mocks.notifyFollowUpSent.mockReset();
    mocks.sendFollowUp.mockReset();
    mocks.stopAgentStream.mockReset();
    mocks.workspaceGet.mockReset();
    mocks.workspaceGet.mockReturnValue(false);
  });

  it('returns an object satisfying the ChatSessionController interface', () => {
    const ctrl = createChatSessionController(makeInit());
    expect(ctrl).toBeDefined();
    expect(typeof ctrl.startRootRun).toBe('function');
    expect(typeof ctrl.resume).toBe('function');
    expect(typeof ctrl.stop).toBe('function');
    expect(typeof ctrl.killExecution).toBe('function');
    expect(typeof ctrl.canStartRootRun).toBe('function');
    expect(typeof ctrl.canSelectModel).toBe('function');
    expect(typeof ctrl.getModelSwitchDisabledReason).toBe('function');
    expect(typeof ctrl.switchActiveModel).toBe('function');
    expect(typeof ctrl.requestCompaction).toBe('function');
    expect(typeof ctrl.getQueuedFollowUpMessages).toBe('function');
    expect(typeof ctrl.clearPendingFollowUps).toBe('function');
    expect(typeof ctrl.submitFollowUp).toBe('function');
    expect(typeof ctrl.awaitFollowUpsIdle).toBe('function');
  });

  it('projects current queued follow-up messages for a stream', () => {
    const streamId = 'stream-queued-follow-ups' as const;
    const ctrl = createChatSessionController(makeInit());
    const queue = ToolUseFollowUpQueue.acquire(streamId);

    try {
      queue.enqueue({ text: 'Fresh controller queue message' });

      expect(ctrl.getQueuedFollowUpMessages(streamId)).toEqual([
        'Fresh controller queue message',
      ]);
      expect(ctrl.getQueuedFollowUpMessages(undefined)).toEqual([]);
    } finally {
      ToolUseFollowUpQueue.release(streamId);
    }
  });

  it('canStartRootRun() delegates to chatTuiCanStartRootRun(session)', () => {
    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    // Fresh session — no run pending
    expect(ctrl.canStartRootRun()).toBe(true);

    // Simulate a pending run
    session.runPromise = new Promise(() => {});
    session.runCompleted = false;
    expect(ctrl.canStartRootRun()).toBe(false);

    // Complete the run
    session.runCompleted = true;
    expect(ctrl.canStartRootRun()).toBe(true);
  });

  it('stop() sets stopRequested on the session', () => {
    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    expect(session.stopRequested).toBe(false);
    ctrl.stop();
    expect(session.stopRequested).toBe(true);
  });

  it('stop() is idempotent', () => {
    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    ctrl.stop();
    ctrl.stop();
    expect(session.stopRequested).toBe(true);
  });

  it('canStartRootRun returns false after stop() when a runPromise is set', () => {
    const session = makeSession({
      runPromise: new Promise(() => {}),
      runCompleted: false,
    });
    const ctrl = createChatSessionController(makeInit({ session }));
    // stop doesn't affect canStartRootRun on its own — it's the runPromise
    // that gates it
    expect(ctrl.canStartRootRun()).toBe(false);
    ctrl.stop();
    expect(ctrl.canStartRootRun()).toBe(false); // runPromise still pending
  });

  it('reads the shared detach-subagents setting key when stopping an active stream', () => {
    const runtimeHost = { emit: vi.fn() };
    const session = makeSession({
      streamId: 'stream-1',
      runtimeHost,
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    mocks.workspaceGet.mockReturnValue(true);
    ctrl.stop();

    expect(mocks.workspaceGet).toHaveBeenCalledWith(
      WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
      false,
    );
    expect(mocks.stopAgentStream).toHaveBeenCalledWith('stream-1', {
      detachActiveChildren: true,
      runtimeHost,
    });
  });

  it('killExecution delegates child termination to the session execution owner', () => {
    const ctrl = createChatSessionController(makeInit());

    mocks.workspaceGet.mockReturnValue(true);
    ctrl.killExecution('execution-1');

    expect(mocks.workspaceGet).toHaveBeenCalledWith(
      WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
      false,
    );
    expect(mocks.kill).toHaveBeenCalledWith('execution-1', {
      detachActiveChildren: true,
    });
  });

  it('requestCompaction reports a missing active flow', () => {
    const ctrl = createChatSessionController(makeInit());

    expect(ctrl.requestCompaction('stream-1')).toEqual({
      status: 'no_active_tool_use',
    });
    expect(mocks.notifyFollowUpSent).not.toHaveBeenCalled();
  });

  it('requestCompaction reports models that cannot compact manually', () => {
    const flowContext = {
      modelHandler: { supportsManualCompaction: false },
      runtimeHost: undefined,
      requestImmediateCompaction: vi.fn(),
    };
    mocks.getToolUseFlowContext.mockReturnValue(flowContext);
    const ctrl = createChatSessionController(makeInit());

    expect(ctrl.requestCompaction('stream-1')).toEqual({
      status: 'unsupported',
    });
    expect(flowContext.requestImmediateCompaction).not.toHaveBeenCalled();
    expect(mocks.notifyFollowUpSent).not.toHaveBeenCalled();
  });

  it('requestCompaction wakes the active tool-use flow', () => {
    const flowContext = {
      modelHandler: { supportsManualCompaction: true },
      runtimeHost: { emit: vi.fn() },
      requestImmediateCompaction: vi.fn(),
    };
    mocks.getToolUseFlowContext.mockReturnValue(flowContext);
    const ctrl = createChatSessionController(makeInit());

    expect(ctrl.requestCompaction('stream-1')).toEqual({
      status: 'requested',
    });
    expect(flowContext.requestImmediateCompaction).toHaveBeenCalledOnce();
    expect(mocks.notifyFollowUpSent).toHaveBeenCalledExactlyOnceWith(
      'stream-1',
      flowContext.runtimeHost,
    );
  });
});

// ---------------------------------------------------------------------------
// buildInitialChatAgentConfig (regression guard)
// ---------------------------------------------------------------------------

describe('buildInitialChatAgentConfig', () => {
  it('builds a tool-use config with the given fields', () => {
    const config = buildInitialChatAgentConfig({
      agent: 'chat',
      model: 'gpt54',
      instruction: 'Prove a compactness lemma.',
      workingDirectory: '/tmp/texra-chat',
    });
    expect(config).toMatchObject({
      agent: 'chat',
      model: 'gpt54',
      instruction: 'Prove a compactness lemma.',
      workingDirectory: '/tmp/texra-chat',
      agentCategory: AgentCategory.ToolUse,
    });
  });

  it('attaches the multi-agent preset id when provided', () => {
    const config = buildInitialChatAgentConfig({
      agent: 'orchestrator',
      model: 'claude',
      instruction: 'go',
      workingDirectory: '/tmp',
      cliMultiAgentPresetId: 'math-team',
    });
    expect(config.cliMultiAgentPresetId).toBe('math-team');
  });

  it('preserves the display instruction separately', () => {
    const config = buildInitialChatAgentConfig({
      agent: 'chat',
      model: 'claude',
      instruction: '<skill>hidden</skill>',
      displayInstruction: 'visible text',
      workingDirectory: '/tmp',
    });
    expect(config.instruction).toBe('<skill>hidden</skill>');
    expect(config.displayInstruction).toBe('visible text');
  });
});
