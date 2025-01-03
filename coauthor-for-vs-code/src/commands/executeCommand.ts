import * as vscode from 'vscode';
import { ensureArray, getConfig } from '../frontend-utils/commonUtils';
import { debug, initializeLogging } from '../logger/logUtils';
import { ToolConfig } from '../agent/ToolConfig';
import { AgentConfig } from '../agent/AgentConfig';

const CHANNEL = 'ExecuteCommand';
initializeLogging(CHANNEL);

// Add the registration function
export function registerExecuteCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.execute', executeCommand.execute),
  );
}

export const executeCommand = {
  execute: async (config: AgentConfig) => {
    const terminalName = `${config.agent}@${config.model}`;
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

    let command = `coauthor run ${config.agent}`;
    if (config.model) {
      command += ` --model=${config.model}`;
    }
    if (config.reflect) {
      command += ` --reflect=true`;
    }

    // Add all file parameters
    const fileConfig = {
      input: { file: config.inputFile, files: config.inputFiles },
      reference: { file: config.referenceFile, files: config.referenceFiles },
      auxiliary: { file: config.auxiliaryFile, files: config.auxiliaryFiles },
      figure: { file: config.figureFile, files: config.figureFiles },
      output: { files: config.outputFiles },
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
    if (config.outputNameOverride) {
      command += ` --outputNameOverride="${config.outputNameOverride}"`;
    }

    // Add flags for enabled tools
    Object.entries(config.toolConfig).forEach(([key, value]) => {
      if (value) {
        command += ` --${key}`;
      }
    });

    if (config.instruction) {
      const escapedInstructions = config.instruction
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
