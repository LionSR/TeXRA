// Third-party imports
// Local imports
import { resolveAgentKey } from '@agent/index';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import {
  MainViewPersistedStateSchema,
  type MainViewPersistedState,
  AgentCategory,
} from '@shared/schemas';

/**
 * Entry-point schema for a restore-into-the-main-view payload: a plain
 * `AgentConfig`. The identity refine runs first because `AgentConfigSchema`
 * prefaults every field — without it, malformed input would validate as an
 * empty default workflow config and silently restore a blank form.
 */
export function buildMainViewState(
  agentConfig: AgentConfig,
): MainViewPersistedState {
  const toolConfig = agentConfig.toolConfig ?? {};
  const agentCategory = agentConfig.agentCategory ?? AgentCategory.Workflow;

  // Resolve agent name to full key (e.g., "criticize" -> "builtIn:criticize").
  // This ensures the frontend receives the exact key used in dropdown options.
  const resolvedAgent = resolveAgentKey(agentConfig.agent, agentCategory);

  // Build partial state from agentConfig and toolConfig, then parse with schema
  // to apply prefault defaults for any missing fields.
  // Note: UIFileFieldsSchema uses catch('') for nullable fields from AgentConfig.
  return MainViewPersistedStateSchema.parse({
    sessionType:
      agentCategory === AgentCategory.ToolUse ? 'toolUse' : 'workflow',
    agent: { [agentCategory]: resolvedAgent },
    model: agentConfig.model,
    instruction: { [agentCategory]: agentConfig.instruction },
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
