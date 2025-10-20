// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import { ProgressViewMessageHandler } from '@progressView/ProgressViewMessageHandler';

// Types
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { OutputFileInfo } from '@agent/output/types';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { WorkflowTaskState } from '@logger/TaskState';

describe('ProgressViewMessageHandler.handleFileOperation', () => {
  const extensionContext = {
    extensionUri: vscode.Uri.file('/tmp/texra'),
  } as unknown as vscode.ExtensionContext;

  let originalExecuteCommand: typeof vscode.commands.executeCommand;

  before(() => {
    originalExecuteCommand = vscode.commands.executeCommand;
  });

  afterEach(() => {
    (vscode.commands as any).executeCommand = originalExecuteCommand;
  });

  it('ignores malformed output metadata when collecting files for toolbar commands', async () => {
    const commandCalls: Array<{ command: string; payload: any }> = [];
    (vscode.commands as any).executeCommand = async (
      command: string,
      payload: any,
    ) => {
      commandCalls.push({ command, payload });
      return undefined;
    };

    const malformedEntry = {
      path: 'should-be-array',
    } as unknown as OutputFileInfo[];

    const providerStub = {
      state: {
        outputFiles: {
          getFiles: () => ({
            0: [
              {
                path: 'generated/output.txt',
                original: 'source/output.tex',
              },
            ],
            1: malformedEntry,
            round: [
              {
                path: 'ignored.txt',
              },
            ],
          }),
        },
      },
    } as unknown as ProgressViewProvider;

    const handler = new ProgressViewMessageHandler(
      providerStub,
      extensionContext,
    );

    const taskState = {
      agentConfig: {
        agent: 'test-agent',
        model: 'test-model',
        inputFile: 'main.tex',
        outputFiles: ['config/output.tex'],
      },
      activeFiles: { output: false },
      session: { agentCategory: AgentCategory.Workflow },
    } as unknown as WorkflowTaskState;

    await (handler as any).handleFileOperation(
      'stream-123',
      taskState,
      'texra.pack',
    );

    assert.strictEqual(commandCalls.length, 1);
    const [{ command, payload }] = commandCalls;
    assert.strictEqual(command, 'texra.pack');
    assert.strictEqual(payload.streamId, 'stream-123');
    assert.deepStrictEqual(
      payload.outputFiles.sort(),
      ['config/output.tex', 'generated/output.txt', 'source/output.tex'].sort(),
    );
    assert.strictEqual(payload.useMultipleOutputs, true);
  });
});
