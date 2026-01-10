// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent core
import type { AgentConfig } from '@agent/core/AgentConfig';
// Internal imports
import {
  AgentCategory,
  AgentType,
  type AgentSessionDescriptor,
} from '@agent/core/AgentDataclass';
import { DEFAULT_TOOL_CONFIG, ToolConfig } from '@agent/core/ToolConfig';
import * as logger from '@logger/logUtils';
import { capitalize } from '@utils/text/stringUtils';
import {
  isPastedImage,
  getPastedImageFullPath,
} from '@utils/files/pastedImageUtils';

const CHANNEL = 'ExecutionManager';
logger.initialize(CHANNEL);

/** Normalize nullish file arrays to empty arrays */
function toArray<T>(files: T[] | undefined | null): T[] {
  return files ?? [];
}

export class ExecutionManager {
  async handleExecute(message: any): Promise<void> {
    const isToolUseAgent = Boolean(message.isToolUseAgent);

    // Tool-use agents don't need input file validation
    if (!isToolUseAgent && !message.inputFile) {
      const openDocs = 'File Management Guide';
      const choice = await vscode.window.showErrorMessage(
        'Please select an input file.',
        openDocs,
      );
      if (choice === openDocs) {
        void vscode.commands.executeCommand('texra.openDoc', 'file-management');
      }
      return;
    }

    const config = this.composeAgentConfig(message, isToolUseAgent);
    await vscode.commands.executeCommand('texra.execute', config);
  }

  private composeAgentConfig(
    message: any,
    isToolUse: boolean,
  ): AgentConfig {
    const session: AgentSessionDescriptor = isToolUse
      ? { agentType: AgentType.ToolUse, agentCategory: AgentCategory.ToolUse }
      : { agentCategory: AgentCategory.Workflow };

    const outputFiles = isToolUse ? [] : toArray<string>(message.outputFiles);
    const useMultipleOutputs = isToolUse
      ? false
      : Boolean(message.outputFilesActive) || outputFiles.length > 1;

    const toolConfig: ToolConfig = isToolUse
      ? DEFAULT_TOOL_CONFIG
      : {
          autoExtractFigure: message.autoExtractFigure,
          autoExtractTikzFigure: message.autoExtractTikzFigure,
          attachTeXCount: message.attachTeXCount,
          attachDiagnostics: message.attachDiagnostics,
          autoCompileInputPdf: message.autoCompileInputPdf,
        };

    return {
      agent: message.agent,
      model: message.model,
      instruction: message.instruction,
      inputFile: message.inputFile ?? '',
      inputFiles: toArray<string>(message.inputFiles),
      referenceFile: message.referenceFile ?? null,
      referenceFiles: toArray<string>(message.referenceFiles),
      auxiliaryFile: message.auxiliaryFile ?? null,
      auxiliaryFiles: toArray<string>(message.auxiliaryFiles),
      mediaFile: this.mapMediaPath(message.mediaFile ?? null),
      mediaFiles: toArray<string>(
        (message.mediaFiles ?? [])
          .map((f: string | null) => this.mapMediaPath(f))
          .filter((f: string | null): f is string => f !== null),
      ),
      editedFile: null,
      agentType: session.agentType,
      session,
      toolConfig,
      useMultipleOutputs,
      outputFiles,
    };
  }

  private mapMediaPath(f: string | null): string | null {
    return f && isPastedImage(f) ? getPastedImageFullPath(f) : f;
  }

  handleFileOperation(message: any): void {
    this.executeCommand(message.command, [
      message.inputFile,
      message.baseFile,
      message.editedFile,
    ]);
  }

  handleHousekeeping(message: any): void {
    this.executeCommand(message.command);
  }

  handleSingleOperation(message: any): void {
    this.executeCommand(message.command, [
      message.inputFile,
      message.agent,
      message.model,
    ]);
  }

  handleMultipleOperation(message: any): void {
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

    this.executeCommand(message.command, [
      message.inputFile,
      message.agent,
      message.model,
      message.outputFiles,
    ]);
  }

  private executeCommand(command: string, args: unknown[] = []): void {
    void vscode.commands.executeCommand(`texra.${command}`, ...args);
  }
}
