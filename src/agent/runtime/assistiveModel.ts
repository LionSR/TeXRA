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

import { MODEL_CONFIGS } from 'llm-zoo';

import { resolveAgentForLaunch } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { getModelUnavailableReason } from '@model/computeModelOptions';

import { getHelperModelName } from './helperModelName';

/**
 * Swap `config`'s model for the configured helper model when the agent is
 * assistive and that helper model is both usable and tool-capable; return
 * `config` unchanged otherwise so the selected model stays in place.
 *
 * Resolves the agent through {@link resolveAgentForLaunch} — the identical call
 * {@link executeAgent} makes — so the entry whose `assistive` flag is read is
 * exactly the entry that launches. A category-blind lookup could pick a hidden
 * same-name shadow (e.g. a disabled custom `latexFixer`) that launch would never
 * choose, switching the wrong runs (or missing the right ones).
 */
export async function preferHelperModelForAssistive(
  config: AgentConfig,
): Promise<AgentConfig> {
  const entry = resolveAgentForLaunch(
    config.agentCategory,
    config.agent,
    config.agentSource,
  )?.entry;
  if (!entry?.assistive) return config;

  const helperModel = getHelperModelName();
  if (helperModel === config.model) return config;

  // A tool-use assistive agent (latexFixer, latexDiff) needs its bash/read_file/
  // edit_file tools; the tool-use flow strips every tool from a model that can't
  // call functions, so keep the selected model rather than switch to a helper
  // model that would leave the agent unable to do its repair/diff work.
  if (
    entry.category === AgentCategory.ToolUse &&
    MODEL_CONFIGS[helperModel]?.capabilities.supportsFunctionCalling === false
  ) {
    return config;
  }

  const unavailable = await getModelUnavailableReason(helperModel);
  if (unavailable) return config;

  return { ...config, model: helperModel };
}
