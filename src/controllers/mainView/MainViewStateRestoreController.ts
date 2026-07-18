// Local imports - agent registry
import { resolveAgentKey } from '@agent/index';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

// Local imports - task state
import type { TaskState } from '@agent/core/state/TaskState';

// Local imports - shared schemas
import {
  MainViewPersistedStateSchema,
  type MainViewPersistedState,
} from '@shared/schemas';

/** Convert a TaskState payload into a full main view state snapshot. */
export function buildMainViewState(
  state: TaskState | AgentConfig,
): MainViewPersistedState {
  const agentConfig = 'agentConfig' in state ? state.agentConfig : state;
  const isToolUse = agentConfig.agentCategory === AgentCategory.ToolUse;
  const toolConfig = agentConfig.toolConfig ?? {};

  const agentCategory = isToolUse
    ? AgentCategory.ToolUse
    : AgentCategory.Workflow;

  // Resolve agent name to full key (e.g., "criticize" -> "builtIn:criticize").
  // This ensures the frontend receives the exact key used in dropdown options.
  const resolvedAgent = resolveAgentKey(agentConfig.agent, agentCategory);

  // Build partial state from agentConfig and toolConfig, then parse with schema
  // to apply prefault defaults for any missing fields.
  // Note: UIFileFieldsSchema uses catch('') for nullable fields from AgentConfig.
  return MainViewPersistedStateSchema.parse({
    sessionType: isToolUse ? 'toolUse' : 'workflow',
    workflowAgent: isToolUse ? undefined : resolvedAgent,
    toolUseAgent: isToolUse ? resolvedAgent : undefined,
    model: agentConfig.model,
    instruction: agentConfig.instruction,
    editedFile: agentConfig.editedFile,
    inputFiles: agentConfig.inputFiles,
    contextFiles: agentConfig.contextFiles,
    mediaFiles: agentConfig.mediaFiles,
    outputFiles: agentConfig.outputFiles,
    autoExtractFigure: toolConfig.autoExtractFigure,
    autoExtractTikzFigure: toolConfig.autoExtractTikzFigure,
    autoCompileInputPdf: toolConfig.autoCompileInputPdf,
    attachTeXCount: toolConfig.attachTeXCount,
  });
}
