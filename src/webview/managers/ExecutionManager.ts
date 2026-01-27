import * as vscode from 'vscode';

import {
  AgentConfigSchema,
  type AgentConfigInput,
} from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { DEFAULT_TOOL_CONFIG, ToolConfigSchema } from '@agent/core/ToolConfig';
import * as logger from '@logger/logUtils';
import {
  isPastedImage,
  getPastedImageFullPath,
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
    const parseResult = AgentConfigSchema.safeParse({
      ...message,
      agentCategory: isToolUse ? AgentCategory.ToolUse : AgentCategory.Workflow,
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
    });

    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];
      const errorPath = issue?.path.join('.') || 'unknown';
      vscode.window.showErrorMessage(
        `Invalid configuration (${errorPath}): ${issue?.message ?? 'validation failed'}`,
      );
      logger.error(
        CHANNEL,
        `AgentConfig validation failed: ${parseResult.error.message}`,
      );
      return;
    }

    await vscode.commands.executeCommand('texra.execute', parseResult.data);
  }

  handleFileOperation(message: CommandMessage): void {
    this.runCommand(message, ['inputFile', 'baseFile', 'editedFile']);
  }

  handleHousekeeping(message: CommandMessage): void {
    this.runCommand(message, []);
  }

  handleSingleOperation(message: CommandMessage): void {
    this.runCommand(message, ['inputFile', 'agent', 'model']);
  }

  handleMultipleOperation(message: CommandMessage): void {
    const operation = message.command.startsWith('pack')
      ? 'Packing'
      : 'Cleaning';
    const files = message.outputFiles?.join(', ') ?? '';
    logger.info(
      CHANNEL,
      `${capitalize(operation)} multiple files: ${message.inputFile}, ${files}`,
    );
    this.runCommand(message, ['inputFile', 'agent', 'model', 'outputFiles']);
  }

  private runCommand(
    message: CommandMessage,
    paramKeys: (keyof CommandMessage)[],
  ): void {
    void vscode.commands.executeCommand(
      `texra.${message.command}`,
      ...paramKeys.map((k) => message[k]),
    );
  }
}
