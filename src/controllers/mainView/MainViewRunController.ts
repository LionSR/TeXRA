// Local imports
import {
  validateRunRequest,
  type ValidatedRunRequest,
} from '@agent/core/state/runRequests';
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  ToolConfigSchema,
  type AgentDelegationScope,
  type MainViewExecuteMessage,
} from '@shared/schemas';
import { filterNotNull } from '@utils/core';
import { isPastedImage } from '@utils/files/pastedImageName';
import { getPastedImageFullPath } from '@utils/files/pastedImageUtils';

export type MainViewRunPreparationResult =
  | { valid: true; request: ValidatedRunRequest }
  | { valid: false; message: string; docsCommand?: string };

export function prepareMainViewRunRequest(
  message: MainViewExecuteMessage,
): MainViewRunPreparationResult {
  // AgentConfigSchema prefaults agent/model; reject missing UI selections before
  // schema parsing so the user sees the real form problem.
  if (!message.agent || !message.model || !message.agentCategory) {
    return {
      valid: false,
      message: 'Choose an agent, a model, and a run type first.',
    };
  }

  return buildMainViewRunRequest(message, message.agent, message.agentCategory);
}

export function prepareMainViewTeamRunRequest(
  message: MainViewExecuteMessage,
  fields: {
    agent: string;
    delegationAgentScope: AgentDelegationScope;
    cli: { multiAgentPresetId: string };
  },
): MainViewRunPreparationResult {
  if (!message.model) {
    return {
      valid: false,
      message: 'Choose a model first.',
    };
  }

  // The renderer's selected agent is intentionally ignored: the authoritative
  // team plan resolves both the root and delegation roster at launch time.
  return buildMainViewRunRequest(
    message,
    fields.agent,
    AgentCategory.ToolUse,
    fields,
  );
}

function buildMainViewRunRequest(
  message: MainViewExecuteMessage,
  agent: string,
  agentCategory: AgentCategory,
  teamFields?: {
    readonly delegationAgentScope: AgentDelegationScope;
    readonly cli: { readonly multiAgentPresetId: string };
  },
): MainViewRunPreparationResult {
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
  // authoritative, so strip it rather than relying on spread order. The
  // session's `cli.outputFile` (if ever set) still passes through for both
  // team and non-team requests.
  const { cli: sessionCli, ...sessionFields } = message.session ?? {};
  const cli = {
    ...(sessionCli?.outputFile != null
      ? { outputFile: sessionCli.outputFile }
      : {}),
    ...(teamFields
      ? { multiAgentPresetId: teamFields.cli.multiAgentPresetId }
      : {}),
  };
  const validation = validateRunRequest({
    config: {
      agent,
      model: message.model,
      instruction: message.instruction,
      displayInstruction: message.displayInstruction,
      memories: message.memories,
      ...sessionFields,
      ...files,
      agentCategory,
      ...(teamFields
        ? { delegationAgentScope: teamFields.delegationAgentScope }
        : {}),
      ...(Object.keys(cli).length > 0 ? { cli } : {}),
      // Workflow output paths are implicit in the input list. Agent settings
      // may still declare generated filenames later during prompt rendering.
      outputFiles: [],
      toolConfig: toolConfigResult.data,
      mediaFiles: (files.mediaFiles ?? [])
        .map((file) =>
          file && isPastedImage(file) ? getPastedImageFullPath(file) : file,
        )
        .filter(filterNotNull),
    },
  });

  if (!validation.valid) {
    return { valid: false, message: validation.message };
  }

  return { valid: true, request: validation.request };
}
