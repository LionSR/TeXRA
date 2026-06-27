// Unit tests for the chat-session controller's state transitions.
// Does not require actual agent execution — the controller's orchestration
// methods (startRootRun, resume) touch real agent runtime infrastructure,
// so these tests focus on the pure predicate delegation, the factory
// contract, and the stop/idle state mutations that are safe to verify
// without a full agent harness.

import PQueue from 'p-queue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRuntimeModelSwitchDisabledReason: vi.fn(),
  hasRuntimeToolUseModelSwitchTarget: vi.fn(),
  requestRuntimeModelSwitch: vi.fn(),
  attachDefaultTerminalResultToast: vi.fn(),
  installTuiApprovals: vi.fn(),
  requestKillExecution: vi.fn(),
  requestStopStream: vi.fn(),
  requestRuntimeFollowUp: vi.fn(),
  runAgent: vi.fn(),
  writeRuntimeTerminalStatus: vi.fn(),
  setCliHelperModel: vi.fn(),
  workspaceGet: vi.fn(),
}));

vi.mock('@agent/runtime/modelSwitch', () => ({
  getRuntimeModelSwitchDisabledReason:
    mocks.getRuntimeModelSwitchDisabledReason,
  hasRuntimeToolUseModelSwitchTarget: mocks.hasRuntimeToolUseModelSwitchTarget,
  requestRuntimeModelSwitch: mocks.requestRuntimeModelSwitch,
}));

vi.mock('@agent/runtime/streamControl', () => ({
  requestKillExecution: mocks.requestKillExecution,
  requestStopStream: mocks.requestStopStream,
}));

vi.mock('@agent/runtime/followUpCommands', () => ({
  requestRuntimeFollowUp: mocks.requestRuntimeFollowUp,
}));

vi.mock('@agent/runtime/runAgent', () => ({
  runAgent: mocks.runAgent,
}));

vi.mock('@agent/runtime/historyCommands', () => ({
  writeRuntimeTerminalStatus: mocks.writeRuntimeTerminalStatus,
}));

vi.mock('@agent/runtime/terminalResultToast', () => ({
  attachDefaultTerminalResultToast: mocks.attachDefaultTerminalResultToast,
}));

vi.mock('@cli/chat/tui/state/subscribeApprovals', () => ({
  installTuiApprovals: mocks.installTuiApprovals,
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  setCliHelperModel: mocks.setCliHelperModel,
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
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { ChatSessionControllerInit } from '@cli/chat/chatSessionController';
import {
  buildInitialChatAgentConfig,
  createChatSessionController,
} from '@cli/chat/chatSessionController';
import { patchStream, resetCliState } from '@cli/chat/tui/state/cliState';
import {
  chatTuiCanStartRootRun,
  type TuiSession,
} from '@cli/chat/tui/state/sessionRunState';
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  STREAM_STATUS,
  type StreamTabId,
} from '@shared/schemas';
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

function makeInit(
  overrides: Partial<ChatSessionControllerInit> = {},
): ChatSessionControllerInit {
  return {
    session: makeSession(),
    getSessionContext: () => makeSessionContext(),
    disposers: [],
    followUpQueue: new PQueue({ concurrency: 1 }),
    snapshotStore: new StreamSnapshotStore(),
    ...overrides,
  };
}

function markWaitingStream(streamId: StreamTabId): void {
  patchStream(streamId, (slice) => ({
    ...slice,
    status: STREAM_STATUS.WAITING,
  }));
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
    resetCliState();
    mocks.getRuntimeModelSwitchDisabledReason.mockReset();
    mocks.hasRuntimeToolUseModelSwitchTarget.mockReset();
    mocks.hasRuntimeToolUseModelSwitchTarget.mockReturnValue(false);
    mocks.requestRuntimeModelSwitch.mockReset();
    mocks.requestRuntimeModelSwitch.mockResolvedValue(false);
    mocks.attachDefaultTerminalResultToast.mockReset();
    mocks.attachDefaultTerminalResultToast.mockReturnValue(vi.fn());
    mocks.installTuiApprovals.mockReset();
    mocks.installTuiApprovals.mockReturnValue(vi.fn());
    mocks.requestKillExecution.mockReset();
    mocks.requestStopStream.mockReset();
    mocks.requestRuntimeFollowUp.mockReset();
    mocks.requestRuntimeFollowUp.mockResolvedValue({ status: 'sent' });
    mocks.runAgent.mockReset();
    mocks.writeRuntimeTerminalStatus.mockReset();
    mocks.writeRuntimeTerminalStatus.mockResolvedValue(undefined);
    mocks.runAgent.mockImplementation(async (_request, options) => {
      const executionId = 'exec-chat-controller-run-agent';
      const streamId = 'stream-chat-controller-run-agent' as StreamTabId;
      options.onExecutionIdAllocated?.(executionId);
      options.onStreamResolved?.(streamId);
      return {
        category: AgentCategory.ToolUse,
        executionId,
        streamId,
        outcome: RUN_OUTCOME.COMPLETED,
        lastResponse: 'Done.',
      };
    });
    mocks.setCliHelperModel.mockReset();
    mocks.setCliHelperModel.mockResolvedValue(undefined);
    mocks.workspaceGet.mockReset();
    mocks.workspaceGet.mockReturnValue(false);
  });

  it('returns an object satisfying the ChatSessionController interface', () => {
    const ctrl = createChatSessionController(makeInit());
    expect(ctrl).toBeDefined();
    expect(typeof ctrl.startRootRun).toBe('function');
    expect(typeof ctrl.resume).toBe('function');
    expect(typeof ctrl.stop).toBe('function');
    expect(typeof ctrl.canStartRootRun).toBe('function');
    expect(typeof ctrl.canSelectModel).toBe('function');
    expect(typeof ctrl.getModelSwitchDisabledReason).toBe('function');
    expect(typeof ctrl.switchModel).toBe('function');
    expect(typeof ctrl.sendFollowUp).toBe('function');
    expect(typeof ctrl.requestCompaction).toBe('function');
    expect(typeof ctrl.killExecution).toBe('function');
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
    expect(mocks.requestStopStream).toHaveBeenCalledWith({
      streamId: 'stream-1',
      detachActiveChildren: true,
      runtimeHost,
    });
  });

  it('starts root chat runs through the runtime run boundary', async () => {
    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));

    ctrl.startRootRun({
      agent: 'chat',
      model: 'demo-model',
      instruction: 'Prove the lemma.',
      agentCategory: AgentCategory.ToolUse,
      workingDirectory: '/tmp/test',
    });

    await session.runPromise;

    expect(mocks.runAgent).toHaveBeenCalledWith(
      {
        config: expect.objectContaining({
          agent: 'chat',
          model: 'demo-model',
          instruction: 'Prove the lemma.',
        }),
      },
      expect.objectContaining({
        enforceCategory: true,
        approvalPromptsUnavailable: false,
        runtimeHost: expect.any(Object),
        onExecutionIdAllocated: expect.any(Function),
        onStreamResolved: expect.any(Function),
        onBeforeWaiting: expect.any(Function),
      }),
    );
    expect(session.executionId).toBe('exec-chat-controller-run-agent');
    expect(session.streamId).toBe('stream-chat-controller-run-agent');
    expect(session.runExitCode).toBe(CliExitCode.Success);
  });

  it('marks an allocated chat execution ERROR when launch fails', async () => {
    const session = makeSession();
    const ctrl = createChatSessionController(makeInit({ session }));
    mocks.runAgent.mockImplementation(async (_request, options) => {
      options.onExecutionIdAllocated?.('exec-chat-controller-failed');
      throw new Error('launch failed');
    });

    ctrl.startRootRun({
      agent: 'chat',
      model: 'demo-model',
      instruction: 'Prove the lemma.',
      agentCategory: AgentCategory.ToolUse,
      workingDirectory: '/tmp/test',
    });

    await session.runPromise;

    expect(mocks.writeRuntimeTerminalStatus).toHaveBeenCalledWith(
      'exec-chat-controller-failed',
      EXECUTION_STATUS.ERROR,
    );
    expect(session.runExitCode).toBe(CliExitCode.AgentError);
  });

  it('projects model-switch availability from waiting stream state and live tool-use flow', () => {
    const streamId = 'stream-model-switch' as StreamTabId;
    const session = makeSession({
      streamId,
      runPromise: new Promise(() => {}),
      runCompleted: false,
    });
    markWaitingStream(streamId);
    mocks.hasRuntimeToolUseModelSwitchTarget.mockReturnValue(true);
    mocks.getRuntimeModelSwitchDisabledReason.mockReturnValue(
      'Provider format differs.',
    );

    const ctrl = createChatSessionController(makeInit({ session }));

    expect(ctrl.canSelectModel()).toBe(true);
    expect(ctrl.getModelSwitchDisabledReason('blocked-model')).toBe(
      'Provider format differs.',
    );
    expect(mocks.hasRuntimeToolUseModelSwitchTarget).toHaveBeenCalledWith({
      streamId,
    });
    expect(mocks.getRuntimeModelSwitchDisabledReason).toHaveBeenCalledWith({
      streamId,
      candidateModel: 'blocked-model',
    });
  });

  it('switchModel sends the active tool-use model switch through the controller boundary', async () => {
    const streamId = 'stream-switch-model' as StreamTabId;
    const session = makeSession({
      streamId,
      runPromise: new Promise(() => {}),
      runCompleted: false,
    });
    markWaitingStream(streamId);
    mocks.hasRuntimeToolUseModelSwitchTarget.mockReturnValue(true);
    mocks.requestRuntimeModelSwitch.mockResolvedValue(true);

    const ctrl = createChatSessionController(makeInit({ session }));

    await ctrl.switchModel('  next-model  ');

    expect(mocks.requestRuntimeModelSwitch).toHaveBeenCalledWith({
      streamId,
      model: 'next-model',
    });
    expect(mocks.setCliHelperModel).toHaveBeenCalledWith('next-model');
  });

  it('sends follow-ups through the runtime boundary from the controller', async () => {
    const streamId = 'stream-follow-up-controller' as StreamTabId;
    const session = makeSession({
      streamId,
      runPromise: new Promise(() => {}),
      runCompleted: false,
    });
    mocks.requestRuntimeFollowUp.mockResolvedValue({
      status: 'queued',
      reason: 'waiting',
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    const delivered = await ctrl.sendFollowUp({
      text: 'Can you expand the compactness step?',
      mediaFiles: ['diagram.png'],
      displayText: 'visible request',
    });

    expect(delivered).toBe(true);
    expect(mocks.requestRuntimeFollowUp).toHaveBeenCalledWith({
      streamId,
      text: 'Can you expand the compactness step?',
      mediaFiles: ['diagram.png'],
      displayText: 'visible request',
    });
  });

  it('marks the root session stopped when a runtime follow-up has no session', async () => {
    const streamId = 'stream-follow-up-missing' as StreamTabId;
    const session = makeSession({
      streamId,
      runPromise: new Promise(() => {}),
      runCompleted: false,
    });
    mocks.requestRuntimeFollowUp.mockResolvedValue({
      status: 'no_session',
      streamStatus: undefined,
    });
    const ctrl = createChatSessionController(makeInit({ session }));

    const delivered = await ctrl.sendFollowUp({
      text: 'Are you still running?',
    });

    expect(delivered).toBe(false);
    expect(session.stopRequested).toBe(true);
  });

  it('killExecution routes kill requests through the controller boundary', () => {
    const ctrl = createChatSessionController(makeInit());

    mocks.workspaceGet.mockReturnValue(true);
    ctrl.killExecution('exec-kill-model-test');

    expect(mocks.workspaceGet).toHaveBeenCalledWith(
      WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
      false,
    );
    expect(mocks.requestKillExecution).toHaveBeenCalledWith({
      executionId: 'exec-kill-model-test',
      detachActiveChildren: true,
    });
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
