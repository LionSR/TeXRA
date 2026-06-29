/**
 * Helper-model preference for assistive agents on direct launches.
 *
 * Assistive agents (latexFixer and the other support/repair helpers, flagged
 * `settings.assistive: true`) do lightweight auxiliary work, so when the user
 * starts one directly — the Fix-Compilation command, a progress-view follow-up,
 * or the webview Run button — it should run on the configured helper model
 * rather than whatever heavyweight model is currently selected.
 *
 * Only root launches reach this resolver: it is applied in {@link runAgent},
 * the high-level entry every host uses for user-initiated runs. Orchestrator
 * delegations go through `executeSubagent` → `executeAgent` directly and never
 * call `runAgent`, so a delegated subagent keeps the model its orchestrator
 * chose.
 */

import { getAgent } from '@agent/index';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { getModelUnavailableReason } from '@model/computeModelOptions';

import { getHelperModelName } from './helperModelName';

/**
 * Return `config` with its model swapped for the configured helper model when
 * the target agent is assistive and that helper model is available in the
 * active API mode. Returns `config` unchanged otherwise — when the agent is not
 * assistive (or the registry isn't loaded), when the helper model already
 * equals the configured model, or when the helper model is unavailable (no key,
 * wrong API mode) so the agent still runs on the originally selected model.
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
