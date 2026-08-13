/**
 * Helper-model preference for the "fix LaTeX" VS Code actions.
 *
 * The Fix-Compilation command and the progress-view compile fixer launch
 * latexFixer through `texra.execute` with `preferHelperModel`, so {@link runAgent}
 * runs them on the configured helper model rather than the heavyweight model the
 * user has selected. Every other launch (a direct main-view Run, the CLI, an
 * orchestrator delegation) leaves the flag off and keeps the chosen model.
 */

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { getModelUnavailableReason } from '@model/computeModelOptions';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';

import { AgentCategory } from '@shared/schemas';
import { getHelperModelName } from './helperModelName';

/**
 * Swap `config`'s model for the configured helper model, or return it unchanged
 * when the helper model already equals it, a tool-use agent's helper model can't
 * call functions (the tool-use flow would strip its tools), or the helper model
 * is unavailable in the active API mode.
 */
export async function applyHelperModelPreference(
  config: AgentConfig,
): Promise<AgentConfig> {
  const helperModel = getHelperModelName();
  if (helperModel === config.model) return config;

  const helperModelConfig = await resolveRuntimeModelConfig(helperModel);

  // A tool-use agent (e.g. latexFixer) needs its tools. The tool-use flow drops
  // every tool unless the model positively declares function calling
  // (`responseCycleToolsForModel` returns nothing when
  // `!capabilities.supportsFunctionCalling`), so mirror that check and bail
  // unless the helper model declares it — not only on an explicit `=== false`.
  if (
    config.agentCategory === AgentCategory.ToolUse &&
    !helperModelConfig?.capabilities.supportsFunctionCalling
  ) {
    return config;
  }

  const unavailable = await getModelUnavailableReason(helperModel);
  if (unavailable) return config;

  return { ...config, model: helperModel };
}
