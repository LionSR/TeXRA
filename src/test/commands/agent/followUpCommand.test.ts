// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import type { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { AgentSessionKind } from '@agent/core/AgentDataclass';
import {
  registerToolUseAgent,
  clearToolUseAgents,
} from '@agent/toolUse/ToolUseAgentRegistry';
import {
  ToolUseSessionManager,
  type ToolUseSessionSnapshot,
} from '@agent/toolUse/ToolUseSessionManager';

// Local imports - commands
import { registerFollowUpCommand } from '@commands/agent/followUpCommand';

describe('followUpCommand', () => {
  let context: vscode.ExtensionContext;
  let registeredCommands: Map<string, (...args: any[]) => unknown>;
  let warningMessages: string[];
  let executeCalls: { command: string; args: any[] }[];
  let followUpHandler:
    | ((payload: { stream: string; text: string }) => Promise<void>)
    | undefined;
  let getSnapshotCalls: StreamTabId[];
  let getSnapshotImplementation:
    | ((streamId: StreamTabId) => ToolUseSessionSnapshot | undefined)
    | undefined;
  let consumeCalls: StreamTabId[];
  let consumeImplementation:
    | ((streamId: StreamTabId) => ToolUseSessionSnapshot | undefined)
    | undefined;
  let setResumingCalls: StreamTabId[];
  let isResumingCalls: StreamTabId[];
  let isResumingImplementation:
    | ((streamId: StreamTabId) => boolean)
    | undefined;
  let enqueueCalls: { streamId: StreamTabId; followUp: string }[];
  let enqueueImplementation:
    | ((streamId: StreamTabId, followUp: string) => boolean)
    | undefined;
  let drainCalls: StreamTabId[];
  let drainImplementation: ((streamId: StreamTabId) => string[]) | undefined;
  let clearCalls: StreamTabId[];
  let executeImplementation:
    | ((command: string, ...args: any[]) => Promise<unknown>)
    | undefined;

  const originalRegisterCommand = vscode.commands.registerCommand;
  const originalExecuteCommand = vscode.commands.executeCommand;
  const originalShowWarningMessage = vscode.window.showWarningMessage;
  const originalGetSnapshot = ToolUseSessionManager.getSnapshotForStream;
  const originalConsumeSnapshot =
    ToolUseSessionManager.consumeSnapshotForStream;
  const originalSetResumingSession = ToolUseSessionManager.setResumingSession;
  const originalIsResumingSession =
    ToolUseSessionManager.isResumingSession;
  const originalEnqueueFollowUp =
    ToolUseSessionManager.enqueueFollowUpWhileResuming;
  const originalClearResumingSession =
    ToolUseSessionManager.clearResumingSession;
  const originalDrainQueuedFollowUps =
    ToolUseSessionManager.drainQueuedFollowUps;

  beforeEach(() => {
    context = {
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    registeredCommands = new Map();
    warningMessages = [];
    executeCalls = [];
    getSnapshotCalls = [];
    getSnapshotImplementation = undefined;
    consumeCalls = [];
    consumeImplementation = undefined;
    setResumingCalls = [];
    isResumingCalls = [];
    isResumingImplementation = undefined;
    enqueueCalls = [];
    enqueueImplementation = undefined;
    drainCalls = [];
    drainImplementation = undefined;
    clearCalls = [];
    executeImplementation = undefined;

    (vscode.commands as any).registerCommand = (
      command: string,
      callback: (...args: unknown[]) => unknown,
    ) => {
      registeredCommands.set(command, callback);
      return { dispose() {} };
    };

    (vscode.commands as any).executeCommand = async (
      command: string,
      ...args: any[]
    ) => {
      executeCalls.push({ command, args });
      if (executeImplementation) {
        return executeImplementation(command, ...args);
      }
      return undefined;
    };

    (vscode.window as any).showWarningMessage = (message: string) => {
      warningMessages.push(message);
      return Promise.resolve(undefined);
    };

    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
        consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
        enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
        clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
        drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
        setResumingSession: typeof ToolUseSessionManager.setResumingSession;
        isResumingSession: typeof ToolUseSessionManager.isResumingSession;
      }
    ).getSnapshotForStream = (streamId: StreamTabId) => {
      getSnapshotCalls.push(streamId);
      if (getSnapshotImplementation) {
        return getSnapshotImplementation(streamId);
      }
      return undefined;
    };
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
        consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
        enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
        clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
        drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
        setResumingSession: typeof ToolUseSessionManager.setResumingSession;
        isResumingSession: typeof ToolUseSessionManager.isResumingSession;
      }
    ).consumeSnapshotForStream = (streamId: StreamTabId) => {
      consumeCalls.push(streamId);
      if (consumeImplementation) {
        return consumeImplementation(streamId);
      }
      return undefined;
    };
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
        consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
        enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
        clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
        drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
        setResumingSession: typeof ToolUseSessionManager.setResumingSession;
        isResumingSession: typeof ToolUseSessionManager.isResumingSession;
      }
    ).setResumingSession = (streamId: StreamTabId) => {
      setResumingCalls.push(streamId);
    };
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
        enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
        clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
        drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      }
    ).enqueueFollowUpWhileResuming = (
      streamId: StreamTabId,
      followUp: string,
    ) => {
      enqueueCalls.push({ streamId, followUp });
      if (enqueueImplementation) {
        return enqueueImplementation(streamId, followUp);
      }
      return false;
    };
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
        enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
        clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
        drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
        isResumingSession: typeof ToolUseSessionManager.isResumingSession;
      }
    ).isResumingSession = (streamId: StreamTabId) => {
      isResumingCalls.push(streamId);
      if (isResumingImplementation) {
        return isResumingImplementation(streamId);
      }
      return false;
    };
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
        enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
        clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
        drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      }
    ).drainQueuedFollowUps = (streamId: StreamTabId) => {
      drainCalls.push(streamId);
      if (drainImplementation) {
        return drainImplementation(streamId);
      }
      return [];
    };
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
        enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
        clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
        drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      }
    ).clearResumingSession = (streamId: StreamTabId) => {
      clearCalls.push(streamId);
    };

    registerFollowUpCommand(context);
    followUpHandler = registeredCommands.get('texra.sendFollowUp') as
      | ((payload: { stream: string; text: string }) => Promise<void>)
      | undefined;
    assert.ok(followUpHandler, 'follow-up command should be registered');
  });

  afterEach(() => {
    clearToolUseAgents();
    (vscode.commands as any).registerCommand = originalRegisterCommand;
    (vscode.commands as any).executeCommand = originalExecuteCommand;
    (vscode.window as any).showWarningMessage = originalShowWarningMessage;
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
        consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
        enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
        clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
        setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      }
    ).getSnapshotForStream = originalGetSnapshot;
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        getSnapshotForStream: typeof ToolUseSessionManager.getSnapshotForStream;
        consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
        enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
        clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
        setResumingSession: typeof ToolUseSessionManager.setResumingSession;
        isResumingSession: typeof ToolUseSessionManager.isResumingSession;
      }
    ).consumeSnapshotForStream = originalConsumeSnapshot;
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        enqueueFollowUpWhileResuming: typeof ToolUseSessionManager.enqueueFollowUpWhileResuming;
      }
    ).enqueueFollowUpWhileResuming = originalEnqueueFollowUp;
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        clearResumingSession: typeof ToolUseSessionManager.clearResumingSession;
      }
    ).clearResumingSession = originalClearResumingSession;
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        isResumingSession: typeof ToolUseSessionManager.isResumingSession;
      }
    ).isResumingSession = originalIsResumingSession;
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        drainQueuedFollowUps: typeof ToolUseSessionManager.drainQueuedFollowUps;
      }
    ).drainQueuedFollowUps = originalDrainQueuedFollowUps;
    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        setResumingSession: typeof ToolUseSessionManager.setResumingSession;
      }
    ).setResumingSession = originalSetResumingSession;
  });

  function createSnapshot(streamId: StreamTabId): ToolUseSessionSnapshot {
    return {
      version: 1,
      executionId: 'exec-id',
      streamId,
      agentName: 'demo-agent',
      model: 'demo-model',
      agentSessionKind: AgentSessionKind.ToolUse,
      messages: [],
      toolState: {
        texcountStats: null,
        lastResponse: '',
        accumulatedOutput: '',
        mediaFiles: [],
        thinkingBlocks: [],
        thinkingAdded: false,
      },
      lastUpdated: Date.now(),
    };
  }

  it('sends follow-up to an active agent', async () => {
    const streamId = 'stream-1' as StreamTabId;
    const received: string[] = [];
    const agent = {
      appendFollowUp: (text: string) => {
        received.push(text);
      },
    } as unknown as BaseToolUseAgent;

    registerToolUseAgent(streamId, agent);

    await followUpHandler!({ stream: streamId, text: 'hello' });

    assert.deepStrictEqual(received, ['hello']);
    assert.strictEqual(executeCalls.length, 0);
    assert.strictEqual(warningMessages.length, 0);
    assert.strictEqual(consumeCalls.length, 0);
  });

  it('resumes lazily when a pending snapshot exists', async () => {
    const streamId = 'stream-2' as StreamTabId;
    const snapshot = createSnapshot(streamId);
    let snapshotAvailable: ToolUseSessionSnapshot | undefined = snapshot;

    getSnapshotImplementation = () => snapshotAvailable;
    consumeImplementation = () => {
      const current = snapshotAvailable;
      snapshotAvailable = undefined;
      return current;
    };
    executeImplementation = async () => ({ success: true });

    await followUpHandler!({ stream: streamId, text: 'resume me' });

    assert.deepStrictEqual(getSnapshotCalls, [streamId]);
    assert.strictEqual(consumeCalls.length, 1);
    assert.deepStrictEqual(setResumingCalls, [streamId]);
    assert.deepStrictEqual(isResumingCalls, [streamId]);
    assert.strictEqual(executeCalls.length, 1);
    assert.strictEqual(executeCalls[0].command, 'texra.resumeAgent');
    assert.strictEqual(executeCalls[0].args.length, 1);
    const payload = executeCalls[0].args[0] as {
      snapshot: ToolUseSessionSnapshot;
      followUp?: string;
    };
    assert.strictEqual(payload.followUp, 'resume me');
    assert.strictEqual(payload.snapshot, snapshot);
    assert.strictEqual(warningMessages.length, 0);
    assert.strictEqual(enqueueCalls.length, 0);
  });

  it('queues follow-ups when resume is already in progress', async () => {
    const streamId = 'stream-4' as StreamTabId;

    enqueueImplementation = () => true;
    isResumingImplementation = () => true;
    getSnapshotImplementation = () => undefined;

    await followUpHandler!({ stream: streamId, text: 'queued follow-up' });

    assert.deepStrictEqual(isResumingCalls, [streamId]);
    assert.strictEqual(getSnapshotCalls.length, 0);
    assert.strictEqual(consumeCalls.length, 0);
    assert.deepStrictEqual(enqueueCalls, [
      { streamId, followUp: 'queued follow-up' },
    ]);
    assert.strictEqual(executeCalls.length, 0);
    assert.strictEqual(warningMessages.length, 0);
    assert.strictEqual(setResumingCalls.length, 0);
  });

  it('warns when no session is available', async () => {
    const streamId = 'stream-3' as StreamTabId;

    getSnapshotImplementation = () => undefined;
    await followUpHandler!({ stream: streamId, text: 'missing' });

    assert.deepStrictEqual(isResumingCalls, [streamId]);
    assert.deepStrictEqual(getSnapshotCalls, [streamId]);
    assert.strictEqual(consumeCalls.length, 0);
    assert.strictEqual(executeCalls.length, 0);
    assert.strictEqual(warningMessages.length, 1);
    assert.strictEqual(
      warningMessages[0],
      'No active tool-use session found for this follow-up.',
    );
    assert.strictEqual(enqueueCalls.length, 0);
    assert.strictEqual(setResumingCalls.length, 0);
  });

  it('drains queued follow-ups and warns when resume fails', async () => {
    const streamId = 'stream-5' as StreamTabId;
    const snapshot = createSnapshot(streamId);

    getSnapshotImplementation = () => snapshot;
    consumeImplementation = () => snapshot;
    drainImplementation = () => ['first follow-up', 'second follow-up'];
    executeImplementation = async () => {
      await ToolUseSessionManager.clearResumingSession(streamId);
      await vscode.window.showWarningMessage(
        'Resume failed. 2 queued follow-ups were lost.',
      );
      return { success: false, lostFollowUps: 2 };
    };

    await followUpHandler!({ stream: streamId, text: 'trigger resume' });

    assert.deepStrictEqual(getSnapshotCalls, [streamId]);
    assert.strictEqual(executeCalls.length, 1);
    assert.strictEqual(executeCalls[0].command, 'texra.resumeAgent');
    assert.strictEqual(drainCalls.length, 0);
    assert.deepStrictEqual(clearCalls, [streamId]);
    assert.deepStrictEqual(setResumingCalls, [streamId]);
    assert.strictEqual(warningMessages.length, 1);
    assert.strictEqual(
      warningMessages[0],
      'Resume failed. 2 queued follow-ups were lost.',
    );
    assert.strictEqual(consumeCalls.length, 0);
  });
});
