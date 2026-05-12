// Local imports - agent
import {
  getAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { getCurrentToolRunContext } from '@agent/toolUse/ToolFileInteractionContext';

/**
 * Return the runtime host owned by the current tool call, falling back to the
 * process-level host for callers that still run outside a tool context.
 */
export function getCurrentToolRuntimeHost(): AgentRuntimeHost {
  return getCurrentToolRunContext()?.runtimeHost ?? getAgentRuntimeHost();
}
