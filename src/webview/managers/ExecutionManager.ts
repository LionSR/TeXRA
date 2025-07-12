// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utils
import { capitalize } from '@frontend/ui/messageUtils';
import {
  isPastedImage,
  getPastedImageFullPath,
} from '@utils/files/pastedImageUtils';
import { getFilesIfNotEmpty } from '@frontend/files/listing';

// Local imports - agent
import { ToolConfig } from '@agent/core/ToolConfig';
import type { AgentConfig } from '@agent/core/AgentConfig';

const CHANNEL = 'ExecutionManager';
logger.initialize(CHANNEL);

export class ExecutionManager {
  constructor() {}

  async handleExecute(message: any): Promise<void> {
    if (!message.inputFile) {
      vscode.window.showErrorMessage('Please select an input file.');
      return;
    }

    const toolConfig: ToolConfig = {
      autoExtractFigure: message.autoExtractFigure,
      autoExtractTikzFigure: message.autoExtractTikzFigure,
      reflect: message.reflect,
      attachTeXCount: message.attachTeXCount,
      usePrefillFromInput: message.usePrefillFromInput,
      printInputPrompt: message.printInputPrompt,
      autoCompileInputPdf: message.autoCompileInputPdf,
    };

    const mapMediaPath = (f: string | null): string | null => {
      if (!f) return null;
      if (isPastedImage(f)) {
        return getPastedImageFullPath(f);
      }
      return f;
    };

    const agentConfig: AgentConfig = {
      agent: message.agent,
      model: message.model,
      instruction: message.instruction,
      inputFile: message.inputFile,
      inputFiles: getFilesIfNotEmpty(message.inputFiles),
      referenceFile: message.referenceFile,
      referenceFiles: getFilesIfNotEmpty(message.referenceFiles),
      auxiliaryFile: message.auxiliaryFile,
      auxiliaryFiles: getFilesIfNotEmpty(message.auxiliaryFiles),
      mediaFile: mapMediaPath(message.mediaFile),
      mediaFiles: message.mediaFiles
        ? getFilesIfNotEmpty(
            message.mediaFiles
              .map(mapMediaPath)
              .filter((f: string | null): f is string => f !== null),
          )
        : null,
      outputFiles: getFilesIfNotEmpty(message.outputFiles),
      editedFile: null,
      toolConfig,
    };

    await vscode.commands.executeCommand('texra.execute', agentConfig);
  }

  handleMerge(message: any): void {
    vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  handleCompare(message: any): void {
    vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  handleAcceptEdited(message: any): void {
    vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  handleHousekeeping(message: any): void {
    vscode.commands.executeCommand(`texra.${message.command}`);
  }

  handleSingleOperation(message: any): void {
    vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.agent,
      message.model,
    );
  }

  async handleMultipleOperation(message: any): Promise<void> {
    const operation = message.command.startsWith('pack')
      ? 'Packing'
      : 'Cleaning';
    const outputFilesStr = Array.isArray(message.outputFiles)
      ? message.outputFiles.join(', ')
      : '';

    logger.info(
      CHANNEL,
      `${capitalize(operation)} multiple files: ${message.inputFile}, ${outputFilesStr}`,
    );

    vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.agent,
      message.model,
      message.outputFiles,
    );
  }
}
