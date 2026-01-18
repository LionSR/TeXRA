// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent core
import type { AgentConfigPayload } from '@agent/core/AgentConfig';
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
  ): AgentConfigPayload {
    // Session descriptor depends on agent type
    const session: AgentSessionDescriptor = isToolUse
      ? { agentType: AgentType.ToolUse, agentCategory: AgentCategory.ToolUse }
      : { agentCategory: AgentCategory.Workflow };

    // Tool-use agents don't produce output files
    const outputFiles: string[] = isToolUse ? [] : (message.outputFiles ?? []);
    const useMultipleOutputs =
      !isToolUse &&
      (Boolean(message.outputFilesActive) || outputFiles.length > 1);

    // Tool config: workflow agents use message values, tool-use uses defaults
    const toolConfig: ToolConfig = isToolUse
      ? DEFAULT_TOOL_CONFIG
      : {
          autoExtractFigure: message.autoExtractFigure,
          autoExtractTikzFigure: message.autoExtractTikzFigure,
          attachTeXCount: message.attachTeXCount,
          attachDiagnostics: message.attachDiagnostics,
          autoCompileInputPdf: message.autoCompileInputPdf,
        };

    // Map media file paths, filtering out null values
    const mapMedia = (f: string | null): string | null => this.mapMediaPath(f);
    const mediaFiles = (message.mediaFiles ?? [])
      .map(mapMedia)
      .filter((f: string | null): f is string => f !== null);

    return {
      agent: message.agent,
      model: message.model,
      instruction: message.instruction,
      inputFile: message.inputFile ?? '',
      inputFiles: message.inputFiles ?? [],
      referenceFile: message.referenceFile ?? null,
      referenceFiles: message.referenceFiles ?? [],
      auxiliaryFile: message.auxiliaryFile ?? null,
      auxiliaryFiles: message.auxiliaryFiles ?? [],
      mediaFile: mapMedia(message.mediaFile ?? null),
      mediaFiles,
      editedFile: null,
      editedFiles: message.editedFiles ?? [],
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
    this.runCommand(message, ['inputFile', 'baseFile', 'editedFile']);
  }

  handleHousekeeping(message: any): void {
    this.runCommand(message, []);
  }

  handleSingleOperation(message: any): void {
    this.runCommand(message, ['inputFile', 'agent', 'model']);
  }

  handleMultipleOperation(message: any): void {
    const operation = message.command.startsWith('pack')
      ? 'Packing'
      : 'Cleaning';
    const files = Array.isArray(message.outputFiles)
      ? message.outputFiles.join(', ')
      : '';
    logger.info(
      CHANNEL,
      `${capitalize(operation)} multiple files: ${message.inputFile}, ${files}`,
    );
    this.runCommand(message, ['inputFile', 'agent', 'model', 'outputFiles']);
  }

  private runCommand(message: any, paramKeys: string[]): void {
    void vscode.commands.executeCommand(
      `texra.${message.command}`,
      ...paramKeys.map((k) => message[k]),
    );
  }
}
