// Unit tests for the chat-session controller's state transitions.
// Does not require actual agent execution — the controller's orchestration
// methods (startRootRun, resume) touch real agent runtime infrastructure,
// so these tests focus on the pure predicate delegation, the factory
// contract, and the stop/idle state mutations that are safe to verify
// without a full agent harness.

import PQueue from 'p-queue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StreamSnapshotStore } from '@transcript';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type {
  ChatSessionController,
  ChatSessionControllerInit,
} from '@cli/chat/chatSessionController';
import {
  buildInitialChatAgentConfig,
  createChatSessionController,
} from '@cli/chat/chatSessionController';
import {
  chatTuiCanStartRootRun,
  type TuiSession,
} from '@cli/chat/tui/state/sessionRunState';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

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
    cwd: '/tmp/test',
    followUpQueue: new PQueue({ concurrency: 1 }),
    snapshotStore: new StreamSnapshotStore(),
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
  it('returns an object satisfying the ChatSessionController interface', () => {
    const ctrl = createChatSessionController(makeInit());
    expect(ctrl).toBeDefined();
    expect(typeof ctrl.startRootRun).toBe('function');
    expect(typeof ctrl.resume).toBe('function');
    expect(typeof ctrl.stop).toBe('function');
    expect(typeof ctrl.canStartRootRun).toBe('function');
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
