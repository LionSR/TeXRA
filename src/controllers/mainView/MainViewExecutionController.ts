// Third-party imports

// Local imports - agent
import {
  validateRuntimeExecutionRequest,
  type RuntimeValidatedExecutionRequest,
} from '@agent/runtime/executionRequests';

// Local imports - shared schemas
import type { MainViewExecuteMessage } from '@shared/mainView';
import { AgentCategory } from '@shared/schemas/agent';
import {
  DEFAULT_TOOL_CONFIG,
  ToolConfigSchema,
} from '@shared/schemas/toolConfig';

// Local imports - utilities
import { filterNotNull } from '@utils/core';
import {
  getPastedImageFullPath,
  isPastedImage,
} from '@utils/files/pastedImageUtils';

export type MainViewExecutionPreparationResult =
  | { valid: true; request: RuntimeValidatedExecutionRequest }
  | { valid: false; message: string; docsCommand?: string };

function mapMediaFile(file: string | null): string | null {
  return file && isPastedImage(file) ? getPastedImageFullPath(file) : file;
}

export function prepareMainViewExecutionRequest(
  message: MainViewExecuteMessage,
): MainViewExecutionPreparationResult {
  // Runtime config parsing prefaults agent/model; reject missing UI selections
  // first so the user sees the real form problem.
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

  const validation = validateRuntimeExecutionRequest({
    config: {
      ...message,
      agentCategory: isToolUse ? AgentCategory.ToolUse : AgentCategory.Workflow,
      // Workflow output paths are implicit in the input list. Agent settings
      // may still declare generated filenames later during prompt rendering.
      outputFiles: [],
      toolConfig: { ...toolConfigResult.data, attachDiagnostics: false },
      mediaFiles: (message.mediaFiles ?? [])
        .map(mapMediaFile)
        .filter(filterNotNull),
      editedFile: null,
    },
  });

  if (!validation.valid) {
    return { valid: false, message: validation.message };
  }

  return { valid: true, request: validation.request };
}
