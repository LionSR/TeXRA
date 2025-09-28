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
  let consumeCalls: StreamTabId[];
  let consumeImplementation:
    | ((streamId: StreamTabId) => ToolUseSessionSnapshot | undefined)
    | undefined;

  const originalRegisterCommand = vscode.commands.registerCommand;
  const originalExecuteCommand = vscode.commands.executeCommand;
  const originalShowWarningMessage = vscode.window.showWarningMessage;
  const originalConsumeSnapshot =
    ToolUseSessionManager.consumeSnapshotForStream;

  beforeEach(() => {
    context = {
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    registeredCommands = new Map();
    warningMessages = [];
    executeCalls = [];
    consumeCalls = [];
    consumeImplementation = undefined;

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
      return undefined;
    };

    (vscode.window as any).showWarningMessage = (message: string) => {
      warningMessages.push(message);
      return Promise.resolve(undefined);
    };

    (
      ToolUseSessionManager as typeof ToolUseSessionManager & {
        consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      }
    ).consumeSnapshotForStream = (streamId: StreamTabId) => {
      consumeCalls.push(streamId);
      if (consumeImplementation) {
        return consumeImplementation(streamId);
      }
      return undefined;
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
        consumeSnapshotForStream: typeof ToolUseSessionManager.consumeSnapshotForStream;
      }
    ).consumeSnapshotForStream = originalConsumeSnapshot;
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

    consumeImplementation = () => {
      const current = snapshotAvailable;
      snapshotAvailable = undefined;
      return current;
    };

    await followUpHandler!({ stream: streamId, text: 'resume me' });

    assert.strictEqual(consumeCalls.length, 1);
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
  });

  it('warns when no session is available', async () => {
    const streamId = 'stream-3' as StreamTabId;

    await followUpHandler!({ stream: streamId, text: 'missing' });

    assert.strictEqual(consumeCalls.length, 1);
    assert.strictEqual(executeCalls.length, 0);
    assert.strictEqual(warningMessages.length, 1);
    assert.strictEqual(
      warningMessages[0],
      'No active tool-use session found for this follow-up.',
    );
  });
});
