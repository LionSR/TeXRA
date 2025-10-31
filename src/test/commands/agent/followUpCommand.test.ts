// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import * as Coordinator from '@agent/toolUse/ToolUseFollowUpCoordinator';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - commands
import { registerFollowUpCommand } from '@commands/agent/followUpCommand';

describe('followUpCommand', () => {
  let context: vscode.ExtensionContext;
  let registeredCommands: Map<string, (...args: any[]) => unknown>;
  const originalRegisterCommand = vscode.commands.registerCommand;
  const originalSendFollowUp = Coordinator.sendFollowUp;

  beforeEach(() => {
    context = {
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    registeredCommands = new Map();

    (vscode.commands as any).registerCommand = (
      command: string,
      callback: (...args: unknown[]) => unknown,
    ) => {
      registeredCommands.set(command, callback);
      return { dispose() {} };
    };
  });

  afterEach(() => {
    (vscode.commands as any).registerCommand = originalRegisterCommand;
    (Coordinator as typeof Coordinator & {
      sendFollowUp: typeof Coordinator.sendFollowUp;
    }).sendFollowUp = originalSendFollowUp;
  });

  it('forwards follow-up payloads to the coordinator', async () => {
    const calls: Array<{ stream: StreamTabId; text: string }> = [];
    (Coordinator as typeof Coordinator & {
      sendFollowUp: typeof Coordinator.sendFollowUp;
    }).sendFollowUp = async (stream: StreamTabId, text: string) => {
      calls.push({ stream, text });
    };

    registerFollowUpCommand(context);

    const handler = registeredCommands.get('texra.sendFollowUp');
    assert.ok(handler, 'Command handler should be registered');

    await handler({ stream: 'stream-123', text: 'Hello world' });

    assert.deepStrictEqual(calls, [
      { stream: 'stream-123' as StreamTabId, text: 'Hello world' },
    ]);
  });
});
