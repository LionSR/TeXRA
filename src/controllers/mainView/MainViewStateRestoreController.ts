// Third-party imports
import { z } from 'zod';

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
 * Entry-point schema for a restore-into-the-main-view payload. Unwraps the
 * legacy `{ agentConfig }` wrapper (the retired TaskState shape) once, so
 * nothing downstream branches on which form arrived.
 *
 * Unwrapping happens in `z.preprocess` rather than as a `z.union` legacy
 * member because `AgentConfigSchema` prefaults every field: a union would let
 * a wrapper whose `agentConfig` is malformed fall through to the plain member
 * and validate as an empty default workflow config, silently restoring a blank
 * form instead of reporting malformed input.
 */
export const RestoreRunConfigInputSchema = z.preprocess(
  (input) =>
    typeof input === 'object' && input !== null && 'agentConfig' in input
      ? input.agentConfig
      : input,
  z
    .unknown()
    .refine((input) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return false;
      }
      const identities = [
        'agent' in input ? input.agent : undefined,
        'model' in input ? input.model : undefined,
      ].filter((value) => value !== undefined);
      return (
        identities.length > 0 &&
        identities.every(
          (value) => typeof value === 'string' && value.trim().length > 0,
        )
      );
    }, 'A restored run configuration must identify a non-empty agent or model.')
    .pipe(AgentConfigSchema),
);

/** Convert a run config into a full main view state snapshot. */
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
