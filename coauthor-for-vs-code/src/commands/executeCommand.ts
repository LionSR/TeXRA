// Third-party imports
import * as vscode from 'vscode';

// Local imports - utilities
import { ensureArray, getConfig } from '../frontend-utils/commonUtils';

// Local imports - agent components
import { AgentConfig } from '../agent/AgentConfig';
import { executeAgent } from '../agent/executeAgent';

// Add the registration function
export function registerExecuteCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.execute', (config: AgentConfig) =>
      executeCommand.executeCommand(config, context),
    ),
  );
}

export const executeCommand = {
  executeCommand: async (
    config: AgentConfig,
    context: vscode.ExtensionContext,
  ) => {
    try {
      // Run the agent directly
      await executeAgent(config, context);
    } catch (error) {
      // If direct execution fails, fall back to terminal execution
      vscode.window.showWarningMessage(
        `Direct execution failed, falling back to terminal: ${error}`,
      );
      await executeViaTerminal(config);
    }
  },
};

/**
 * Execute command via terminal as fallback.
 */
async function executeViaTerminal(config: AgentConfig): Promise<void> {
  const terminalName = `${config.agent}@${config.model}`;
  const terminalNew = vscode.window.createTerminal(terminalName);
  terminalNew.show();

  // Check if virtual environment string is configured
  const virtualEnvString = getConfig<string>('python.virtualEnvString', '');

  if (virtualEnvString) {
    if (terminalNew.shellIntegration) {
      const execution =
        terminalNew.shellIntegration.executeCommand(virtualEnvString);
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
      terminalNew.sendText(virtualEnvString);
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

  terminalNew.sendText(command);
}
