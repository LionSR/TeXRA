import * as vscode from 'vscode';
import { ensureArray, getConfig } from '../utils/commonUtils';
import { debug, initializeLogging } from '../utils/logUtils';

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
    autoExtractFigure: boolean,
    autoExtractTikzFigure: boolean,
    autoExtractTikzFigureReflect: boolean,
    includeTexCount: boolean,
    usePrefillFromInput: boolean,
    autoConfirmation: boolean,
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
    addSelectedFileToCommand(inputFile, '--input_file');
    addSelectedFileToCommand(referenceFile, '--reference_file');
    addSelectedFileToCommand(auxiliaryFile, '--auxiliary_file');
    addSelectedFileToCommand(figureFile, '--figure_file');

    // Add multiple files if they exist
    const addFilesToCommand = (files: string[] | null, flag: string) => {
      if (files && files.length > 0) {
        command += ` ${flag}="${files.join(',')}"`;
      }
    };
    addFilesToCommand(ensureArray(inputFiles), '--input_files');
    addFilesToCommand(ensureArray(auxiliaryFiles), '--auxiliary_files');
    addFilesToCommand(ensureArray(referenceFiles), '--reference_files');
    addFilesToCommand(ensureArray(figureFiles), '--figure_files');
    addFilesToCommand(ensureArray(outputFiles), '--output_files');

    addSelectedFileToCommand(outputNameOverride, '--output_name_override');

    const flagsToAdd = [
      { condition: autoExtractFigure, flag: '--auto_extract_figure' },
      { condition: autoExtractTikzFigure, flag: '--auto_extract_tikz_figure' },
      {
        condition: autoExtractTikzFigureReflect,
        flag: '--auto_extract_tikz_figure_reflect',
      },
      { condition: includeTexCount, flag: '--include_tex_count' },
      { condition: usePrefillFromInput, flag: '--use_prefill_from_input' },
      { condition: autoConfirmation, flag: '--auto_confirmation' },
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
