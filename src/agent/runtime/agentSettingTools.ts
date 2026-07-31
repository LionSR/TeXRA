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
import { resolveToolDefinitions } from '@tools/registry';

export function resolveAgentSettingTools(
  settings: AgentSettingInput,
  channel: string,
): AgentSettingInput {
  if (!Array.isArray(settings.tools)) return settings;
  return {
    ...settings,
    tools: resolveToolDefinitions(settings.tools, (name, reason) =>
      logger.warn(channel, `Tool "${name}" ${reason}`),
    ),
  };
}
