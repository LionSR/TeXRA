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

    // Add all file parameters
    const fileConfig = {
      input: { file: inputFile, files: inputFiles },
      reference: { file: referenceFile, files: referenceFiles },
      auxiliary: { file: auxiliaryFile, files: auxiliaryFiles },
      figure: { file: figureFile, files: figureFiles },
      output: { files: outputFiles },
    };

    // Add single files
    Object.entries(fileConfig).forEach(([type, config]) => {
      if ('file' in config && config.file) {
        command += ` --${type}File="${config.file}"`;
      }
      if (config.files && config.files.length > 0) {
        command += ` --${type}Files="${ensureArray(config.files).join(',')}"`;
      }
    });

    // Add output name override separately as it doesn't follow the pattern
    if (outputNameOverride) {
      command += ` --outputNameOverride="${outputNameOverride}"`;
    }

    // Add flags for enabled tools
    Object.entries(toolConfig).forEach(([key, value]) => {
      if (value) {
        command += ` --${key}`;
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
