// Third-party imports
import * as vscode from 'vscode';

// Local imports - shared schemas
import {
  DEFAULT_TOOL_CONFIG,
  ToolConfigSchema,
} from '@shared/schemas/toolConfig';

// Local imports - agent
import {
  AgentConfigSchema,
  type AgentConfigInput,
} from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';

// Local imports - common
import {
  buildExecutionRequest,
  validateExecutionRequest,
} from '@common/agent/executionRequestUtils';
import { buildFileOperationPayload } from '@common/files/fileOperationPayload';

// Local imports - logger
import * as logger from '@logger/logUtils';

// Local imports - utils
import {
  getPastedImageFullPath,
  isPastedImage,
} from '@utils/files/pastedImageUtils';
import { capitalize } from '@utils/text/stringUtils';

// Third-party imports - types
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
    const validation = validateExecutionRequest({
      agent: message.agent,
      model: message.model,
      inputFile: message.inputFile,
      isToolUse: message.isToolUseAgent,
    });
    if (!validation.ok) {
      if (validation.action) {
        const selection = await vscode.window.showErrorMessage(
          validation.message ?? 'Execution validation failed.',
          validation.action.label,
        );
        if (selection === validation.action.label) {
          void vscode.commands.executeCommand(
            validation.action.command,
            ...(validation.action.args ?? []),
          );
        }
        return;
      }

      vscode.window.showErrorMessage(
        validation.message ?? 'Execution validation failed.',
      );
      return;
    }

    const isToolUse = Boolean(message.isToolUseAgent);

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

    const request = buildExecutionRequest(parseResult.data);
    await vscode.commands.executeCommand('texra.execute', request);
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

  handleOutputOperation(message: CommandMessage): void {
    const isPack = message.command.startsWith('pack');
    const payload = buildFileOperationPayload({
      inputFile: message.inputFile ?? '',
      agent: message.agent ?? '',
      model: message.model ?? '',
      outputFiles: message.outputFiles ?? [],
      useMultipleOutputs: message.command.includes('Multiple'),
    });

    const operation = isPack ? 'Packing' : 'Cleaning';
    const files = payload.outputFiles.join(', ');
    logger.info(
      CHANNEL,
      `${capitalize(operation)} output files: ${payload.inputFile}${files ? `, ${files}` : ''}`,
    );

    void vscode.commands.executeCommand(
      isPack ? 'texra.pack' : 'texra.clean',
      payload,
    );
  }
}
