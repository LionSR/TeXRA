// Local imports
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  validateExecutionRequest,
  type ValidatedExecutionRequest,
} from '@agent/core/state/executionRequests';
import type { AgentDelegationScope } from '@shared/schemas/agentRoster';
import type { MainViewExecuteMessage } from '@shared/schemas/mainView/executeMessage';
import {
  DEFAULT_TOOL_CONFIG,
  ToolConfigSchema,
} from '@shared/schemas/toolConfig';
import { filterNotNull } from '@utils/core';
import { isPastedImage } from '@utils/files/pastedImageName';
import { getPastedImageFullPath } from '@utils/files/pastedImageUtils';

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

  return buildMainViewExecutionRequest(
    message,
    message.agent,
    message.isToolUseAgent ? AgentCategory.ToolUse : AgentCategory.Workflow,
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
      message:
        'Model selection required. Please select a model before running.',
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
      message: 'Please select an input file.',
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
