// Third-party imports

// Local imports - agent
import type { AgentConfigInput } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import {
  validateExecutionRequest,
  type ValidatedExecutionRequest,
} from '@agent/core/executionRequests';

// Local imports - shared schemas
import {
  DEFAULT_TOOL_CONFIG,
  ToolConfigSchema,
} from '@shared/schemas/toolConfig';

// Local imports - utilities
import {
  getPastedImageFullPath,
  isPastedImage,
} from '@utils/files/pastedImageUtils';
import type { z } from 'zod';

/**
 * Message shape from the main view for agent execution.
 * ToolConfig fields are sent flat from the UI form.
 */
export type MainViewExecuteMessage = Omit<AgentConfigInput, 'mediaFiles'> & {
  /** UI toggle indicating tool-use vs workflow agent. */
  isToolUseAgent?: boolean;
  /** Media files may contain nulls from UI and are filtered during processing. */
  mediaFiles?: (string | null)[];
} & z.input<typeof ToolConfigSchema>;

export type MainViewExecutionPreparationResult =
  | { valid: true; request: ValidatedExecutionRequest }
  | { valid: false; message: string; docsCommand?: string };

function mapMediaFile(file: string | null): string | null {
  return file && isPastedImage(file) ? getPastedImageFullPath(file) : file;
}

export function prepareMainViewExecutionRequest(
  message: MainViewExecuteMessage,
): MainViewExecutionPreparationResult {
  // AgentConfigSchema prefaults agent/model; reject missing UI selections before
  // schema parsing so the user sees the real form problem.
  if (!message.agent || !message.model) {
    return {
      valid: false,
      message:
        'Agent and model selection required. Please select both before running.',
    };
  }

  const isToolUse = Boolean(message.isToolUseAgent);
  if (!isToolUse && (message.inputFiles?.length ?? 0) === 0) {
    return {
      valid: false,
      message: 'Please select an input file.',
      docsCommand: 'file-management',
    };
  }

  const toolConfigResult = isToolUse
    ? { success: true as const, data: DEFAULT_TOOL_CONFIG }
    : ToolConfigSchema.safeParse(message);
  if (!toolConfigResult.success) {
    const issue = toolConfigResult.error.issues[0];
    const path = issue?.path.join('.') || 'toolConfig';
    return {
      valid: false,
      message: `Invalid tool configuration (${path}): ${issue?.message ?? 'validation failed'}`,
    };
  }

  const validation = validateExecutionRequest({
    config: {
      ...message,
      agentCategory: isToolUse ? AgentCategory.ToolUse : AgentCategory.Workflow,
      outputFiles: message.outputFiles ?? message.inputFiles,
      toolConfig: { ...toolConfigResult.data, attachDiagnostics: false },
      mediaFiles: (message.mediaFiles ?? [])
        .map(mapMediaFile)
        .filter((file: string | null): file is string => file !== null),
      editedFile: null,
    },
  });

  if (!validation.valid) {
    return { valid: false, message: validation.message };
  }

  return { valid: true, request: validation.request };
}
