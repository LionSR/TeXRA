// Local imports
import {
  validateExecutionRequest,
  type ValidatedExecutionRequest,
} from '@agent/core/state/executionRequests';
import type {
  AgentDelegationScope,
  MainViewExecuteMessage,
} from '@shared/schemas';
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  ToolConfigSchema,
} from '@shared/schemas';
import { filterNotNull } from '@utils/core';
import { isPastedImage } from '@utils/files/pastedImageName';
import { getPastedImageFullPath } from '@utils/files/pastedImageUtils';

export type MainViewExecutionPreparationResult =
  | { valid: true; request: ValidatedExecutionRequest }
  | { valid: false; message: string; docsCommand?: string };

export function prepareMainViewExecutionRequest(
  message: MainViewExecuteMessage,
): MainViewExecutionPreparationResult {
  // AgentConfigSchema prefaults agent/model; reject missing UI selections before
  // schema parsing so the user sees the real form problem.
  if (!message.agent || !message.model || !message.agentCategory) {
    return {
      valid: false,
      message: 'Choose an agent, a model, and a run type first.',
    };
  }

  return buildMainViewExecutionRequest(
    message,
    message.agent,
    message.agentCategory,
  );
}

export function prepareMainViewTeamExecutionRequest(
  message: MainViewExecuteMessage,
  fields: {
    agent: string;
    delegationAgentScope: AgentDelegationScope;
    cliMultiAgentPresetId: string;
  },
): MainViewExecutionPreparationResult {
  if (!message.model) {
    return {
      valid: false,
      message: 'Choose a model first.',
    };
  }

  // The renderer's selected agent is intentionally ignored: the authoritative
  // team plan resolves both the root and delegation roster at launch time.
  return buildMainViewExecutionRequest(
    message,
    fields.agent,
    AgentCategory.ToolUse,
    fields,
  );
}

function buildMainViewExecutionRequest(
  message: MainViewExecuteMessage,
  agent: string,
  agentCategory: AgentCategory,
  teamFields?: {
    readonly delegationAgentScope: AgentDelegationScope;
    readonly cliMultiAgentPresetId: string;
  },
): MainViewExecutionPreparationResult {
  const isToolUse = agentCategory === AgentCategory.ToolUse;
  const files = message.files ?? {};
  if (!isToolUse && (files.inputFiles?.length ?? 0) === 0) {
    return {
      valid: false,
      message: 'Choose an input file first.',
      docsCommand: 'file-management',
    };
  }

  const toolConfigResult = isToolUse
    ? { success: true as const, data: DEFAULT_TOOL_CONFIG }
    : ToolConfigSchema.safeParse(message.toolConfig);
  if (!toolConfigResult.success) {
    const issue = toolConfigResult.error.issues[0];
    const path = issue?.path.join('.') || 'toolConfig';
    return {
      valid: false,
      message: `Invalid tool configuration (${path}): ${issue?.message ?? 'validation failed'}`,
    };
  }

  // The webview's session preset id is always nullish; only teamFields is
  // authoritative, so strip it rather than relying on spread order.
  const { cliMultiAgentPresetId: _, ...sessionFields } = message.session ?? {};
  const validation = validateExecutionRequest({
    config: {
      agent,
      model: message.model,
      instruction: message.instruction,
      displayInstruction: message.displayInstruction,
      memories: message.memories,
      ...sessionFields,
      ...files,
      agentCategory,
      ...teamFields,
      // Workflow output paths are implicit in the input list. Agent settings
      // may still declare generated filenames later during prompt rendering.
      outputFiles: [],
      toolConfig: { ...toolConfigResult.data, attachDiagnostics: false },
      mediaFiles: (files.mediaFiles ?? [])
        .map((file) =>
          file && isPastedImage(file) ? getPastedImageFullPath(file) : file,
        )
        .filter(filterNotNull),
      editedFile: null,
    },
  });

  if (!validation.valid) {
    return { valid: false, message: validation.message };
  }

  return { valid: true, request: validation.request };
}
