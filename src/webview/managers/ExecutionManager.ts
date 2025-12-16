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
import { ToolConfig, DEFAULT_TOOL_CONFIG } from '@agent/core/ToolConfig';
import { capitalize } from '@frontend/ui/messageUtils';
import * as logger from '@logger/logUtils';
import {
  isPastedImage,
  getPastedImageFullPath,
} from '@utils/files/pastedImageUtils';

// Message schemas - single source of truth
import {
  ExecuteMessageSchema,
  FileOperationMessageSchema,
  HousekeepingMessageSchema,
  SingleOperationMessageSchema,
  MultipleOperationMessageSchema,
  type ExecuteMessage,
  type FileOperationMessage,
  type HousekeepingMessage,
  type SingleOperationMessage,
  type MultipleOperationMessage,
} from '../types/messages';

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

  /**
   * Handle execute command from webview.
   * Validates the message and routes to workflow or tool-use handler.
   */
  async handleExecute(message: unknown): Promise<void> {
    const parsed = ExecuteMessageSchema.safeParse(message);
    if (!parsed.success) {
      logger.warn(CHANNEL, 'Invalid execute message', {
        data: { errors: parsed.error.issues },
      });
      return;
    }

    const msg = parsed.data;
    const isToolUseAgent = !!msg.isToolUseAgent;
    const config = isToolUseAgent
      ? this.buildToolUseCommandPayload(msg)
      : await this.buildWorkflowCommandPayload(msg);

    if (!config) {
      return;
    }

    await vscode.commands.executeCommand('texra.execute', config);
  }

  private async buildWorkflowCommandPayload(
    message: ExecuteMessage,
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

  private buildToolUseCommandPayload(message: ExecuteMessage): AgentConfig {
    return this.composeToolUseAgentConfig(message, {
      agentType: AgentType.ToolUse,
      agentCategory: AgentCategory.ToolUse,
    });
  }

  private composeWorkflowAgentConfig(
    message: ExecuteMessage,
    session: AgentSessionDescriptor,
  ): AgentConfig {
    const baseConfig = this.composeBaseAgentConfig(message, session);
    const outputFiles = getFilesIfNotEmpty<string>(message.outputFiles);
    const useMultipleOutputs = !!(
      message.outputFilesActive || outputFiles.length > 1
    );

    return {
      ...baseConfig,
      useMultipleOutputs,
      outputFiles,
    };
  }

  private composeToolUseAgentConfig(
    message: ExecuteMessage,
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
    message: ExecuteMessage,
    session: AgentSessionDescriptor,
  ): Omit<AgentConfig, 'useMultipleOutputs' | 'outputFiles'> {
    // Apply tool configuration - start with defaults and override with provided values
    const toolConfig: ToolConfig = {
      ...DEFAULT_TOOL_CONFIG,
      ...(message.autoExtractFigure !== undefined && {
        autoExtractFigure: message.autoExtractFigure,
      }),
      ...(message.autoExtractTikzFigure !== undefined && {
        autoExtractTikzFigure: message.autoExtractTikzFigure,
      }),
      ...(message.attachTeXCount !== undefined && {
        attachTeXCount: message.attachTeXCount,
      }),
      ...(message.attachDiagnostics !== undefined && {
        attachDiagnostics: message.attachDiagnostics,
      }),
      ...(message.autoCompileInputPdf !== undefined && {
        autoCompileInputPdf: message.autoCompileInputPdf,
      }),
    };

    const mapMediaPath = (f: string | null): string | null => {
      if (!f) return null;
      if (isPastedImage(f)) {
        return getPastedImageFullPath(f);
      }
      return f;
    };

    return {
      agent: message.agent ?? 'correct',
      model: message.model ?? 'gemini3p',
      instruction: message.instruction ?? '',
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

  private handleFileOperationInternal(message: FileOperationMessage): void {
    vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  /**
   * Handle merge command from webview.
   */
  handleMerge(message: unknown): void {
    const parsed = FileOperationMessageSchema.safeParse(message);
    if (parsed.success) {
      this.handleFileOperationInternal(parsed.data);
    }
  }

  /**
   * Handle compare command from webview.
   */
  handleCompare(message: unknown): void {
    const parsed = FileOperationMessageSchema.safeParse(message);
    if (parsed.success) {
      this.handleFileOperationInternal(parsed.data);
    }
  }

  /**
   * Handle accept edited command from webview.
   */
  handleAcceptEdited(message: unknown): void {
    const parsed = FileOperationMessageSchema.safeParse(message);
    if (parsed.success) {
      this.handleFileOperationInternal(parsed.data);
    }
  }

  /**
   * Handle housekeeping command from webview.
   */
  handleHousekeeping(message: unknown): void {
    const parsed = HousekeepingMessageSchema.safeParse(message);
    if (parsed.success) {
      vscode.commands.executeCommand(`texra.${parsed.data.command}`);
    }
  }

  /**
   * Handle single file operation command from webview.
   */
  handleSingleOperation(message: unknown): void {
    const parsed = SingleOperationMessageSchema.safeParse(message);
    if (parsed.success) {
      const { command, inputFile, agent, model } = parsed.data;
      vscode.commands.executeCommand(
        `texra.${command}`,
        inputFile,
        agent,
        model,
      );
    }
  }

  /**
   * Handle multiple file operation command from webview.
   */
  async handleMultipleOperation(message: unknown): Promise<void> {
    const parsed = MultipleOperationMessageSchema.safeParse(message);
    if (!parsed.success) {
      return;
    }

    const { command, inputFile, agent, model, outputFiles } = parsed.data;
    const operation = command.startsWith('pack') ? 'Packing' : 'Cleaning';
    const outputFilesStr = Array.isArray(outputFiles)
      ? outputFiles.join(', ')
      : '';

    logger.info(
      CHANNEL,
      `${capitalize(operation)} multiple files: ${inputFile}, ${outputFilesStr}`,
    );

    vscode.commands.executeCommand(
      `texra.${command}`,
      inputFile,
      agent,
      model,
      outputFiles,
    );
  }
}
