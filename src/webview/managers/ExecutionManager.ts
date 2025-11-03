// Third-party imports
// Third-party imports
import * as vscode from 'vscode';

// Local imports - webview
import type { AgentConfig } from '@agent/core/AgentConfig';

// Local imports - agent
import {
  AgentCategory,
  AgentType,
  type AgentSessionDescriptor,
} from '@agent/core/AgentDataclass';
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

function getFilesIfNotEmpty<T>(files: T[] | undefined | null): T[] {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  return files;
}

export class ExecutionManager {
  constructor() {}

  async handleExecute(message: any): Promise<void> {
    const isToolUseAgent = Boolean(message.isToolUseAgent);
    const config = isToolUseAgent
      ? this.buildToolUseCommandPayload(message)
      : await this.buildWorkflowCommandPayload(message);

    if (!config) {
      return;
    }

    await vscode.commands.executeCommand('texra.execute', config);
  }

  private async buildWorkflowCommandPayload(
    message: any,
  ): Promise<AgentConfig | null> {
    if (!message.inputFile) {
      const openDocs = 'File Management Guide';
      const choice = await vscode.window.showErrorMessage(
        'Please select an input file.',
        openDocs,
      );
      if (choice === openDocs) {
        vscode.commands.executeCommand('texra.openDoc', 'file-management');
      }
      return null;
    }

    return this.composeWorkflowAgentConfig(message, {
      agentCategory: AgentCategory.Workflow,
    });
  }

  private buildToolUseCommandPayload(message: any): AgentConfig {
    return this.composeToolUseAgentConfig(message, {
      agentType: AgentType.ToolUse,
      agentCategory: AgentCategory.ToolUse,
    });
  }

  private composeWorkflowAgentConfig(
    message: any,
    session: AgentSessionDescriptor,
  ): AgentConfig {
    const baseConfig = this.composeBaseAgentConfig(message, session);
    const outputFiles = getFilesIfNotEmpty<string>(message.outputFiles);
    const useMultipleOutputs = Boolean(
      message.outputFilesActive || outputFiles.length > 1,
    );

    return {
      ...baseConfig,
      useMultipleOutputs,
      outputFiles,
    };
  }

  private composeToolUseAgentConfig(
    message: any,
    session: AgentSessionDescriptor,
  ): AgentConfig {
    const baseConfig = this.composeBaseAgentConfig(message, session);

    return {
      ...baseConfig,
      // Tool-use runs intentionally stay single-output so the execution
      // pipeline never attempts to resolve `_multiple` agent variants or
      // manage output file selections that the UI disables for this mode.
      useMultipleOutputs: false,
      outputFiles: [],
    };
  }

  private composeBaseAgentConfig(
    message: any,
    session: AgentSessionDescriptor,
  ): Omit<AgentConfig, 'useMultipleOutputs' | 'outputFiles'> {
    const toolConfig: ToolConfig = {
      autoExtractFigure: message.autoExtractFigure,
      autoExtractTikzFigure: message.autoExtractTikzFigure,
      attachTeXCount: message.attachTeXCount,
      attachDiagnostics: message.attachDiagnostics,
      autoCompileInputPdf: message.autoCompileInputPdf,
    };

    const mapMediaPath = (f: string | null): string | null => {
      if (!f) return null;
      if (isPastedImage(f)) {
        return getPastedImageFullPath(f);
      }
      return f;
    };

    return {
      agent: message.agent,
      model: message.model,
      instruction: message.instruction,
      inputFile: message.inputFile ?? '',
      inputFiles: getFilesIfNotEmpty<string>(message.inputFiles),
      referenceFile: message.referenceFile ?? null,
      referenceFiles: getFilesIfNotEmpty<string>(message.referenceFiles),
      auxiliaryFile: message.auxiliaryFile ?? null,
      auxiliaryFiles: getFilesIfNotEmpty<string>(message.auxiliaryFiles),
      mediaFile: mapMediaPath(message.mediaFile ?? null),
      mediaFiles: getFilesIfNotEmpty<string>(
        (message.mediaFiles ?? [])
          .map(mapMediaPath)
          .filter((f: string | null): f is string => f !== null),
      ),
      editedFile: null,
      toolConfig,
      agentType: session.agentType,
      session,
    };
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
