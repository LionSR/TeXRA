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

  private composeAgentConfig(message: any, isToolUse: boolean): AgentConfig {
    const session: AgentSessionDescriptor = isToolUse
      ? { agentType: AgentType.ToolUse, agentCategory: AgentCategory.ToolUse }
      : { agentCategory: AgentCategory.Workflow };

    const outputFiles: string[] = isToolUse ? [] : (message.outputFiles ?? []);
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

    const mediaFiles = (message.mediaFiles ?? [])
      .map((f: string | null) => this.mapMediaPath(f))
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
      mediaFile: this.mapMediaPath(message.mediaFile ?? null),
      mediaFiles,
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

  /**
   * Execute a command with arguments extracted from message.
   * Consolidates handleFileOperation, handleHousekeeping, handleSingleOperation, handleMultipleOperation.
   */
  handleCommand(message: any): void {
    const { command, inputFile, baseFile, editedFile, agent, model, outputFiles } = message;

    // Log pack/clean operations
    if (outputFiles && (command.startsWith('pack') || command.startsWith('clean'))) {
      const operation = command.startsWith('pack') ? 'Packing' : 'Cleaning';
      const outputFilesStr = Array.isArray(outputFiles) ? outputFiles.join(', ') : '';
      logger.info(CHANNEL, `${capitalize(operation)} multiple files: ${inputFile}, ${outputFilesStr}`);
    }

    // Build args based on command type (file ops use different args than agent ops)
    const isFileOp = command.includes('Diff') || command.includes('Compare');
    const args = isFileOp
      ? [inputFile, baseFile, editedFile].filter((a) => a !== undefined)
      : [inputFile, agent, model, outputFiles].filter((a) => a !== undefined);

    void vscode.commands.executeCommand(`texra.${command}`, ...args);
  }
}
