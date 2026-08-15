/**
 * Single owner of the YAML `tools:` materialization step: turn an agent
 * definition's declared tool names into resolved {@link ToolDefinition}
 * objects before the settings reach `AgentSettingSchema`.
 *
 * Shared by the local definition loader ({@link ./agentLoad}) and the remote
 * one (`@agent/remote/RemoteAgentLoader`), which report unresolved names on
 * their own log channels. Both already depend on `@tools/registry`, so this
 * module adds nothing to either one's module closure.
 */
import type { AgentSettingInput } from '@agent/core/definition/AgentDataclass';
import * as logger from '@logger/logUtils';
import { AgentCategory } from '@shared/schemas/agent';
import { resolveToolDefinitions } from '@tools/registry';

export function resolveAgentSettingTools(
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
    logger.warn(
      channel,
      `Workflow-category agent declares tools: [${settings.tools
        .map((tool) => (typeof tool === 'string' ? tool : tool.name))
        .join(', ')}]. Workflow runs never dispatch tool calls, so these are inert; remove tools: or make the agent toolUse.`,
    );
  }
  return {
    ...settings,
    tools: resolveToolDefinitions(settings.tools, (name, reason) =>
      logger.warn(channel, `Tool "${name}" ${reason}`),
    ),
  };
}
