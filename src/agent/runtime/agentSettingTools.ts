/**
 * Single owner of the YAML `tools:` normalization step: turn an agent
 * definition's declared tool names into the bare `{ name }` entries
 * `AgentSettingSchema` expects. The contract a tool is advertised with — its
 * description and parameter schema — is the registry's, applied once per run
 * by `resolveAgentTools`, so nothing here touches the tool registry.
 *
 * Shared by the local definition loader ({@link ./agentLoad}) and the remote
 * one (`@agent/remote/RemoteAgentLoader`). The normalization is pure: a
 * load-time warning comes back in the result, and each loader reports it on
 * its own log channel.
 */
import type { AgentSettingInput } from '@agent/core/definition/AgentDataclass';
import { AgentCategory } from '@shared/schemas';

export function normalizeAgentSettingTools(settings: AgentSettingInput): {
  readonly settings: AgentSettingInput;
  /** Set when the declared tools can never run; the caller logs it at warn. */
  readonly inertToolsWarning: string | undefined;
} {
  if (!Array.isArray(settings.tools))
    return { settings, inertToolsWarning: undefined };
  const tools = settings.tools.map((tool) =>
    typeof tool === 'string' ? { name: tool } : tool,
  );
  // Latent silent-failure trap: the shared settings schema accepts `tools:`
  // for every category, but a workflow (reflection) run only *sends* the
  // definitions to the provider — a returned tool call is never dispatched.
  // Say so at load time instead of letting the agent author discover it from
  // a model that keeps asking for a tool that never answers.
  const inertToolsWarning =
    settings.agentCategory === AgentCategory.Workflow && tools.length > 0
      ? `Workflow-category agent declares tools: [${tools
          .map((tool) => tool.name)
          .join(
            ', ',
          )}]. Workflow runs never dispatch tool calls, so these are inert; remove tools: or make the agent toolUse.`
      : undefined;
  return { settings: { ...settings, tools }, inertToolsWarning };
}
