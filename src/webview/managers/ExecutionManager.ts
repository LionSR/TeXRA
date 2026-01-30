import * as vscode from 'vscode';

import {
  DEFAULT_TOOL_CONFIG,
  ToolConfigSchema,
} from '@shared/schemas/toolConfig';
import type { AgentConfigInput } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { validateExecutionRequest } from '@common/execution/executionRequests';
import * as logger from '@logger/logUtils';
import {
  getPastedImageFullPath,
  isPastedImage,
} from '@utils/files/pastedImageUtils';
import { capitalize } from '@utils/text/stringUtils';
import type { z } from 'zod';

const CHANNEL = 'ExecutionManager';
logger.initialize(CHANNEL);

/**
 * Message shape from webview for agent execution.
 * Extends AgentConfigInput with UI-specific fields.
 * ToolConfig fields are sent flat from the UI form.
 */
type ExecuteMessage = AgentConfigInput & {
  /** UI toggle indicating tool-use vs workflow agent */
  isToolUseAgent?: boolean;
  /** UI toggle for multiple outputs mode */
  outputFilesActive?: boolean;
  /** Media files may contain nulls from UI (filtered during processing) */
  mediaFiles?: (string | null)[];
} & z.input<typeof ToolConfigSchema>;

/** Message shape for command-based operations. */
interface CommandMessage {
  command: string;
  inputFile?: string;
  baseFile?: string;
  editedFile?: string;
  agent?: string;
  model?: string;
  outputFiles?: string[];
}

export class ExecutionManager {
  async handleExecute(message: ExecuteMessage): Promise<void> {
    // IMPORTANT: Validate required fields before schema parsing.
    // AgentConfigSchema uses .prefault() for agent/model (see AgentConfig.ts:96-97),
    // which would silently provide defaults instead of failing on missing values.
    if (!message.agent || !message.model) {
      vscode.window.showErrorMessage(
        'Agent and model selection required. Please select both before running.',
      );
      return;
    }

    const isToolUse = Boolean(message.isToolUseAgent);

    // Tool-use agents don't need input file validation
    if (!isToolUse && !message.inputFile) {
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

    // Map media file paths (pasted images need full path resolution)
    const mapMedia = (f: string | null): string | null =>
      f && isPastedImage(f) ? getPastedImageFullPath(f) : f;

    // Tool-use agents don't produce output files
    const outputFiles: string[] = isToolUse ? [] : (message.outputFiles ?? []);

    // Tool config: tool-use uses defaults, workflow agents use message values (schema provides defaults)
    const toolConfig = isToolUse
      ? DEFAULT_TOOL_CONFIG
      : ToolConfigSchema.parse(message);

    // Schema provides defaults via .prefault(), we only override conditional fields
    const request = {
      config: {
        ...message,
        agentCategory: isToolUse
          ? AgentCategory.ToolUse
          : AgentCategory.Workflow,
        outputFiles,
        useMultipleOutputs:
          !isToolUse &&
          (Boolean(message.outputFilesActive) || outputFiles.length > 1),
        toolConfig,
        mediaFile: mapMedia(message.mediaFile ?? null),
        mediaFiles: (message.mediaFiles ?? [])
          .map(mapMedia)
          .filter((f: string | null): f is string => f !== null),
        editedFile: null,
      },
    };

    const validation = validateExecutionRequest(request);
    if (!validation.valid) {
      vscode.window.showErrorMessage(validation.message);
      logger.error(
        CHANNEL,
        `AgentConfig validation failed: ${validation.message}`,
      );
      return;
    }

    await vscode.commands.executeCommand('texra.execute', validation.request);
  }

  handleFileOperation(message: CommandMessage): void {
    void vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.baseFile,
      message.editedFile,
    );
  }

  handleHousekeeping(message: CommandMessage): void {
    void vscode.commands.executeCommand(`texra.${message.command}`);
  }

  handleSingleOperation(message: CommandMessage): void {
    void vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.agent,
      message.model,
    );
  }

  handleMultipleOperation(message: CommandMessage): void {
    const outputFiles = message.outputFiles ?? [];
    const operation = message.command.startsWith('pack')
      ? 'packing'
      : 'cleaning';
    logger.info(
      CHANNEL,
      `${capitalize(operation)} multiple files: ${message.inputFile}, ${outputFiles.join(', ')}`,
    );
    void vscode.commands.executeCommand(
      `texra.${message.command}`,
      message.inputFile,
      message.agent,
      message.model,
      outputFiles,
    );
  }
}
