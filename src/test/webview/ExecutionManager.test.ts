// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview
import { ExecutionManager } from '@webview/managers/ExecutionManager';

function createMessage(overrides: Partial<Record<string, any>> = {}) {
  return {
    command: 'execute',
    isToolUseAgent: false,
    agent: 'chat',
    model: 'model',
    instruction: 'do something',
    inputFile: 'main.tex',
    outputFilesActive: false,
    outputFiles: [],
    autoExtractFigure: false,
    autoExtractTikzFigure: false,
    attachTeXCount: false,
    attachDiagnostics: false,
    autoCompileInputPdf: false,
    ...overrides,
  };
}

describe('ExecutionManager', () => {
  const originalExecuteCommand = vscode.commands.executeCommand;

  afterEach(() => {
    (vscode.commands as any).executeCommand = originalExecuteCommand;
  });

  it('disables multiple outputs for tool-use sessions', async () => {
    const manager = new ExecutionManager();
    const executed: Array<{ command: string; payload: any }> = [];

    (vscode.commands as any).executeCommand = async (
      command: string,
      payload: any,
    ) => {
      executed.push({ command, payload });
      return undefined;
    };

    const message = createMessage({
      isToolUseAgent: true,
      outputFilesActive: true,
      outputFiles: ['a.tex', 'b.tex'],
    });

    await manager.handleExecute(message);

    assert.strictEqual(executed.length, 1);
    assert.strictEqual(executed[0]?.command, 'texra.execute');
    const config = executed[0]?.payload;
    assert.ok(config, 'Expected payload to be provided');
    assert.strictEqual(config.useMultipleOutputs, false);
    assert.strictEqual(config.outputFiles, null);
  });
});
