// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - test
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import {
  registerMainViewCommands,
  mainViewCommands,
} from '@commands/system/mainViewCommands';

describe('Main View Commands', () => {
  let context: vscode.ExtensionContext;
  let registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  let warningMessages: string[];
  let executeCommandResults: Map<string, any>;

  // Mock VS Code API
  const originalRegisterCommand = vscode.commands.registerCommand;
  const originalExecuteCommand = vscode.commands.executeCommand;
  const originalShowWarningMessage = vscode.window.showWarningMessage;

  beforeEach(() => {
    context = {
      subscriptions: [],
    } as any;

    registeredCommands = new Map();
    warningMessages = [];
    executeCommandResults = new Map();

    // Mock registerCommand
    (vscode.commands as any).registerCommand = (
      command: string,
      callback: (...args: unknown[]) => unknown,
    ) => {
      registeredCommands.set(command, callback);
      const disposable = { dispose: () => {} };
      return disposable;
    };

    // Mock executeCommand
    (vscode.commands as any).executeCommand = async (
      command: string,
      ...args: any[]
    ) => {
      if (executeCommandResults.has(command)) {
        const result = executeCommandResults.get(command);
        if (result instanceof Error) {
          throw result;
        }
        return result;
      }
      return undefined;
    };

    // Mock showWarningMessage
    (vscode.window as any).showWarningMessage = (message: string) => {
      warningMessages.push(message);
      return Promise.resolve();
    };
  });

  afterEach(() => {
    // Restore original functions
    (vscode.commands as any).registerCommand = originalRegisterCommand;
    (vscode.commands as any).executeCommand = originalExecuteCommand;
    (vscode.window as any).showWarningMessage = originalShowWarningMessage;
  });

  describe('registerMainViewCommands', () => {
    it('should register reset command and add to subscriptions', () => {
      const result = registerMainViewCommands(context);

      assert.ok(registeredCommands.has(mainViewCommands.reset));
      assert.strictEqual(context.subscriptions.length, 1);
      assert.ok(result.resetCommand);
    });
  });

  describe('reset command', () => {
    let resetHandler: (...args: unknown[]) => unknown;
    let mockWebviewView: vscode.WebviewView;
    let postMessageCalls: any[];

    beforeEach(() => {
      postMessageCalls = [];
      mockWebviewView = {
        webview: {
          postMessage: (message: any) => {
            postMessageCalls.push(message);
            return Promise.resolve(true);
          },
        },
      } as any;

      registerMainViewCommands(context);
      resetHandler = registeredCommands.get(mainViewCommands.reset)!;
    });

    it('should send STATE_RESTORE message when webview is available', async () => {
      executeCommandResults.set('texra.getWebviewView', mockWebviewView);

      await resetHandler();

      assert.strictEqual(postMessageCalls.length, 1);
      assert.deepStrictEqual(postMessageCalls[0], {
        command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
        state: {},
      });
      assert.strictEqual(warningMessages.length, 0);
    });

    it('should show warning message when webview is undefined', async () => {
      executeCommandResults.set('texra.getWebviewView', undefined);

      await resetHandler();

      assert.strictEqual(warningMessages.length, 1);
      assert.strictEqual(
        warningMessages[0],
        'Main view is not available. Please ensure the TeXRA view is open.',
      );
      assert.strictEqual(postMessageCalls.length, 0);
    });

    it('should handle errors gracefully when executeCommand fails', async () => {
      executeCommandResults.set(
        'texra.getWebviewView',
        new Error('Command failed'),
      );

      // The safeExecuteCommand should catch the error and return undefined
      await resetHandler();

      assert.strictEqual(warningMessages.length, 1);
      assert.strictEqual(
        warningMessages[0],
        'Main view is not available. Please ensure the TeXRA view is open.',
      );
      assert.strictEqual(postMessageCalls.length, 0);
    });
  });
});
