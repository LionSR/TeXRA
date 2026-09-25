/**
 * The load-time check on an agent's parsed `tools:`. Shared by the local
 * definition loader ({@link ./agentLoad}) and the remote one
 * (`@agent/remote/RemoteAgentLoader`); each reports the warning on its own
 * log channel. The `{ name }` shorthand itself is parsed by the settings
 * schema.
 */
import type { AgentSetting } from '@agent/core/definition/AgentDataclass';
import { AgentCategory } from '@shared/schemas';

/**
 * Set when the declared tools can never run; the caller logs it at warn.
 *
 * Latent silent-failure trap: the shared settings schema accepts `tools:`
 * for every category, but a workflow (reflection) run only *sends* the
 * definitions to the provider; a returned tool call is never dispatched.
 * Say so at load time instead of letting the agent author discover it from
 * a model that keeps asking for a tool that never answers.
 */
export function inertToolsWarning(settings: AgentSetting): string | undefined {
  return settings.agentCategory === AgentCategory.Workflow &&
    settings.tools.length > 0
    ? `Workflow-category agent declares tools: [${settings.tools
        .map((tool) => tool.name)
        .join(
          ', ',
        )}]. Workflow runs never dispatch tool calls, so these are inert; remove tools: or make the agent toolUse.`
    : undefined;
}
