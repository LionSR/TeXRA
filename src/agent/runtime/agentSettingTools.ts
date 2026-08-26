/**
 * Single owner of the YAML `tools:` normalization step: turn an agent
 * definition's declared tool names into the bare `{ name }` entries
 * `AgentSettingSchema` expects. The contract a tool is advertised with — its
 * description and parameter schema — is the registry's, applied once per run
 * by `resolveAgentTools`, so nothing here touches the tool registry.
 *
 * Shared by the local definition loader ({@link ./agentLoad}) and the remote
 * one (`@agent/remote/RemoteAgentLoader`), which report on their own log
 * channels.
 */
import type { AgentSettingInput } from '@agent/core/definition/AgentDataclass';
import { createLog } from '@logger/logUtils';
import { AgentCategory } from '@shared/schemas';

export function normalizeAgentSettingTools(
  settings: AgentSettingInput,
  channel: string,
): AgentSettingInput {
  if (!Array.isArray(settings.tools)) return settings;
  // Latent silent-failure trap: the shared settings schema accepts `tools:`
  // for every category, but a workflow (reflection) run only *sends* the
  // definitions to the provider — a returned tool call is never dispatched.
  // Say so at load time instead of letting the agent author discover it from
  // a model that keeps asking for a tool that never answers.
  if (
    settings.agentCategory === AgentCategory.Workflow &&
    settings.tools.length > 0
  ) {
    // The channel is caller-threaded (local and remote loaders report on their
    // own), so bind at call scope rather than freezing one at module load.
    createLog(channel).warn(
      `Workflow-category agent declares tools: [${settings.tools
        .map((tool) => (typeof tool === 'string' ? tool : tool.name))
        .join(
          ', ',
        )}]. Workflow runs never dispatch tool calls, so these are inert; remove tools: or make the agent toolUse.`,
    );
  }
  return {
    ...settings,
    tools: settings.tools.map((tool) =>
      typeof tool === 'string' ? { name: tool } : tool,
    ),
  };
}
