// Third-party imports
// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview
import type { AgentConfig } from '@agent/core/AgentConfig';

// Local imports - agent
import { ToolConfig } from '@agent/core/ToolConfig';

// Local imports - utils
import { capitalize } from '@frontend/ui/messageUtils';

// Local imports - log
import * as logger from '@logger/logUtils';
import {
  isPastedImage,
  getPastedImageFullPath,
} from '@utils/files/pastedImageUtils';

const CHANNEL = 'ExecutionManager';
logger.initialize(CHANNEL);

function getFilesIfNotEmpty<T>(files: T[] | undefined | null): T[] | null {
  if (!Array.isArray(files) || files.length === 0) {
    return null;
  }
  return files;
}

export class ExecutionManager {
  constructor() {}

  async handleExecute(message: any): Promise<void> {
    const isToolUseAgent = Boolean(message.isToolUseAgent);

    if (!message.inputFile && !isToolUseAgent) {
      const openDocs = 'File Management Guide';
      const choice = await vscode.window.showErrorMessage(
        'Please select an input file.',
        openDocs,
      );
      if (choice === openDocs) {
        vscode.commands.executeCommand('texra.openDoc', 'file-management');
      }
      return;
    }

    const toolConfig: ToolConfig = {
      autoExtractFigure: message.autoExtractFigure,
      autoExtractTikzFigure: message.autoExtractTikzFigure,
      reflect: message.reflect,
      attachTeXCount: message.attachTeXCount,
      attachDiagnostics: message.attachDiagnostics,
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

    const outputFiles = getFilesIfNotEmpty<string>(message.outputFiles);
    const useMultipleOutputs = Boolean(
      message.outputFilesActive ||
        (Array.isArray(outputFiles) && outputFiles.length > 1),
    );

    const agentConfig: AgentConfig = {
      agent: message.agent,
      model: message.model,
      instruction: message.instruction,
      useMultipleOutputs,
      inputFile: message.inputFile,
      inputFiles: getFilesIfNotEmpty<string>(message.inputFiles),
      referenceFile: message.referenceFile,
      referenceFiles: getFilesIfNotEmpty<string>(message.referenceFiles),
      auxiliaryFile: message.auxiliaryFile,
      auxiliaryFiles: getFilesIfNotEmpty<string>(message.auxiliaryFiles),
      mediaFile: mapMediaPath(message.mediaFile),
      mediaFiles: message.mediaFiles
        ? getFilesIfNotEmpty<string>(
            message.mediaFiles
              .map(mapMediaPath)
              .filter((f: string | null): f is string => f !== null),
          )
        : null,
      outputFiles,
      editedFile: null,
      toolConfig,
    };

    await vscode.commands.executeCommand('texra.execute', agentConfig);
  }

  private handleFileOperation(message: any): void {
    vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  handleMerge(message: any): void {
    this.handleFileOperation(message);
  }

  handleCompare(message: any): void {
    this.handleFileOperation(message);
  }

  handleAcceptEdited(message: any): void {
    this.handleFileOperation(message);
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
