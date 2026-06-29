/**
 * Helper-model preference for assistive agents.
 *
 * Assistive agents (latexFixer and the other support/repair helpers, flagged
 * `settings.assistive: true`) do lightweight auxiliary work, so a direct launch
 * should prefer the configured helper model over the heavyweight model the user
 * has selected. Applied in {@link runAgent}, the root entry every host uses for
 * user-initiated runs: orchestrator delegations call `executeAgent` directly and
 * never reach `runAgent`, so a delegated subagent keeps its orchestrator's model.
 */

import { getAgent } from '@agent/index';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { getModelUnavailableReason } from '@model/computeModelOptions';

import { getHelperModelName } from './helperModelName';

/**
 * Swap `config`'s model for the configured helper model when the agent is
 * assistive and that helper model is available in the active API mode; return
 * `config` unchanged otherwise (a non-assistive agent, an unloaded registry, or
 * an unavailable helper model all leave the selected model in place).
 */
export async function preferHelperModelForAssistive(
  config: AgentConfig,
): Promise<AgentConfig> {
  const entry = getAgent(config.agent, config.agentCategory);
  if (!entry?.assistive) return config;

  const helperModel = getHelperModelName();
  if (helperModel === config.model) return config;

  const unavailable = await getModelUnavailableReason(helperModel);
  if (unavailable) return config;

  return { ...config, model: helperModel };
}
