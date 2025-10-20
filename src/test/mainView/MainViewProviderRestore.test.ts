// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { MainViewProvider } from '@/MainViewProvider';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import { bus } from '@eventBus/ProgressEventBus';
import * as configUtils from '@utils/config';
import * as toolUtils from '@utils/system/toolUtils';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { DEFAULT_TOOL_CONFIG } from '@agent/core/ToolConfig';
import type { TaskState } from '@logger/TaskState';
import type { FileType } from '@utils/config';

describe('MainViewProvider restore handling', () => {
  const originalWatchConfig = configUtils.watchConfig;
  const originalGetConfig = configUtils.getConfig;
  const originalCheckCoreDependencies = toolUtils.checkCoreDependencies;
  const originalCreateFileSystemWatcher =
    vscode.workspace.createFileSystemWatcher;
  const originalOnDidChangeActiveTextEditor =
    vscode.window.onDidChangeActiveTextEditor;
  const originalRegisterCommand = vscode.commands.registerCommand;
  const originalGetCommands = vscode.commands.getCommands;
  const originalExecuteCommand = vscode.commands.executeCommand;

  let context: vscode.ExtensionContext;
  let provider: MainViewProvider | undefined;
  let contextStore: Map<string, unknown>;
  let commandCalls: Array<{ command: string; args: unknown[] }>;
  let postMessageCalls: any[];

  beforeEach(() => {
    context = {
      subscriptions: [],
      extensionUri: vscode.Uri.parse('file:///texra-test'),
    } as unknown as vscode.ExtensionContext;

    contextStore = new Map();
    commandCalls = [];
    postMessageCalls = [];

    (configUtils as any).watchConfig = () => {};
    (configUtils as any).getConfig = <T>(_key: string, defaultValue: T) => {
      if (_key === 'ui.showDependencyReminders') {
        return false as T;
      }
      return defaultValue;
    };
    (toolUtils as any).checkCoreDependencies = async () => [];

    (vscode.workspace as any).createFileSystemWatcher = () => ({
      onDidCreate: () => ({ dispose: () => {} }),
      onDidDelete: () => ({ dispose: () => {} }),
      dispose: () => {},
    });

    (vscode.window as any).onDidChangeActiveTextEditor = () => ({
      dispose: () => {},
    });

    (vscode.commands as any).registerCommand = (
      _command: string,
      _callback: (...args: unknown[]) => unknown,
    ) => ({ dispose: () => {} });

    (vscode.commands as any).getCommands = async () => [];

    (vscode.commands as any).executeCommand = async (
      command: string,
      ...args: unknown[]
    ) => {
      commandCalls.push({ command, args });
      if (command === 'setContext') {
        const [key, value] = args as [string, unknown];
        contextStore.set(key, value);
        return undefined;
      }
      if (command === 'getContext') {
        const [key] = args as [string];
        return contextStore.get(key);
      }
      return undefined;
    };
  });

  afterEach(() => {
    provider?.dispose();
    provider = undefined;

    (configUtils as any).watchConfig = originalWatchConfig;
    (configUtils as any).getConfig = originalGetConfig;
    (toolUtils as any).checkCoreDependencies = originalCheckCoreDependencies;
    (vscode.workspace as any).createFileSystemWatcher =
      originalCreateFileSystemWatcher;
    (vscode.window as any).onDidChangeActiveTextEditor =
      originalOnDidChangeActiveTextEditor;
    (vscode.commands as any).registerCommand = originalRegisterCommand;
    (vscode.commands as any).getCommands = originalGetCommands;
    (vscode.commands as any).executeCommand = originalExecuteCommand;
  });

  it('replays buffered restore requests once the view becomes available', async () => {
    const taskState = {
      agentConfig: {
        model: 'test-model',
        agent: 'test-agent',
        instruction: 'Restore me',
        useMultipleOutputs: false,
        inputFile: 'main.tex',
        inputFiles: null,
        referenceFile: null,
        referenceFiles: null,
        auxiliaryFile: null,
        auxiliaryFiles: null,
        mediaFile: null,
        mediaFiles: null,
        outputFiles: null,
        editedFile: null,
        toolConfig: DEFAULT_TOOL_CONFIG,
        session: { agentCategory: AgentCategory.Workflow },
      },
      session: { agentCategory: AgentCategory.Workflow },
      activeFiles: {} as Record<FileType, boolean>,
    } as TaskState;

    bus.emit('restoreStateRequest', {
      taskState,
      source: 'test-suite',
      metadata: { case: 'buffered' },
    });

    provider = new MainViewProvider(context);

    assert.strictEqual(contextStore.get('texra.hasStateToRestore'), true);
    assert.deepStrictEqual(contextStore.get('texra.stateToRestore'), taskState);

    const mockWebviewView = {
      webview: {
        options: {},
        postMessage: async (message: any) => {
          postMessageCalls.push(message);
          return true;
        },
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        get html() {
          return '';
        },
        set html(_value: string) {},
      },
      onDidDispose: () => ({ dispose: () => {} }),
      show: () => {},
    } as unknown as vscode.WebviewView;

    provider.resolveWebviewView(mockWebviewView);
    await new Promise((resolve) => setImmediate(resolve));

    const restoreMessage = postMessageCalls.find(
      (message) => message.command === MAIN_VIEW_COMMANDS.STATE_RESTORE,
    );

    assert.ok(restoreMessage, 'Expected restore message to be posted');
    assert.deepStrictEqual(restoreMessage.state, taskState);
    assert.deepStrictEqual(restoreMessage.source, 'test-suite');

    assert.strictEqual(contextStore.get('texra.hasStateToRestore'), false);
    assert.strictEqual(contextStore.get('texra.stateToRestore'), undefined);

    const focusCalls = commandCalls.filter(
      (call) => call.command === 'texra.mainView.focus',
    );
    assert.ok(focusCalls.length >= 1, 'Expected focus command to run');
  });
});
