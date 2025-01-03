import * as vscode from 'vscode';
import { ensureArray, getConfig } from '../frontend-utils/commonUtils';
import { debug, initializeLogging } from '../logger/logUtils';
import { ToolConfig } from '../agent/ToolConfig';

const CHANNEL = 'ExecuteCommand';
initializeLogging(CHANNEL);

// Add the registration function
export function registerExecuteCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.execute', executeCommand.execute),
  );
}

export const executeCommand = {
  execute: async (
    agent: string,
    model: string,
    reflect: string,
    // parameters
    inputFile: string,
    inputFiles: string[] | null,
    referenceFile: string | null,
    referenceFiles: string[] | null,
    auxiliaryFile: string | null,
    auxiliaryFiles: string[] | null,
    figureFile: string | null,
    figureFiles: string[] | null,
    // instructions
    instructions: string,
    // tools
    toolConfig: ToolConfig,
    // output options
    outputFiles: string[],
    outputNameOverride: string,
  ) => {
    const terminalName = `${agent}@${model}`;
    const terminal_new = vscode.window.createTerminal(terminalName);
    terminal_new.show();

    // Check if virtual environment string is configured
    const virtualEnvString = getConfig<string>('python.virtualEnvString', '');

    if (virtualEnvString) {
      if (terminal_new.shellIntegration) {
        const execution =
          terminal_new.shellIntegration.executeCommand(virtualEnvString);
        await new Promise<void>((resolve) => {
          const disposable = vscode.window.onDidEndTerminalShellExecution(
            (event) => {
              if (event.execution === execution) {
                disposable.dispose();
                resolve();
              }
            },
          );
        });
      } else {
        terminal_new.sendText(virtualEnvString);
      }
    }
    let command = `coauthor run ${agent}`;
    if (model) {
      command += ` --model=${model}`;
    }
    if (reflect !== 'default') {
      command += ` --reflect=${reflect}`;
    }

    // Add selected file if they exist
    const addSelectedFileToCommand = (file: string | null, flag: string) => {
      if (file) {
        command += ` ${flag}="${file}"`;
      }
    };
    addSelectedFileToCommand(inputFile, '--inputFile');
    addSelectedFileToCommand(referenceFile, '--referenceFile');
    addSelectedFileToCommand(auxiliaryFile, '--auxiliaryFile');
    addSelectedFileToCommand(figureFile, '--figureFile');

    // Add multiple files if they exist
    const addFilesToCommand = (files: string[] | null, flag: string) => {
      if (files && files.length > 0) {
        command += ` ${flag}="${files.join(',')}"`;
      }
    };
    addFilesToCommand(ensureArray(inputFiles), '--inputFiles');
    addFilesToCommand(ensureArray(auxiliaryFiles), '--auxiliaryFiles');
    addFilesToCommand(ensureArray(referenceFiles), '--referenceFiles');
    addFilesToCommand(ensureArray(figureFiles), '--figureFiles');
    addFilesToCommand(ensureArray(outputFiles), '--outputFiles');

    addSelectedFileToCommand(outputNameOverride, '--outputNameOverride');

    const flagsToAdd = [
      { condition: toolConfig.autoExtractFigure, flag: '--autoExtractFigure' },
      {
        condition: toolConfig.autoExtractTikzFigure,
        flag: '--autoExtractTikzFigure',
      },
      {
        condition: toolConfig.autoExtractTikzFigureReflect,
        flag: '--autoExtractTikzFigureReflect',
      },
      { condition: toolConfig.includeTexCount, flag: '--includeTexCount' },
      {
        condition: toolConfig.usePrefillFromInput,
        flag: '--usePrefillFromInput',
      },
      { condition: toolConfig.autoConfirmation, flag: '--autoConfirmation' },
      { condition: toolConfig.printInputPrompt, flag: '--printInputPrompt' },
      { condition: toolConfig.useOpenrouter, flag: '--useOpenrouter' },
    ];
    flagsToAdd.forEach(({ condition, flag }) => {
      if (condition) {
        command += ` ${flag}`;
      }
    });

    if (instructions) {
      const escapedInstructions = instructions
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/{/g, '\\{')
        .replace(/}/g, '\\}')
        .trim();
      command += ` --instruction="${escapedInstructions}"`;
    }

    terminal_new.sendText(command);
  },
};
