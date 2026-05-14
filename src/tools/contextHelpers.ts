/**
 * Tool-side helpers for reading the active RunContext.
 *
 * Centralizes the "look up a required field, throw a tool-friendly error
 * when missing" pattern that several tools used to spell out individually
 * with slightly different error wording.
 */

import { tryUseRunContext, type RunContext } from '@agent/runtime/RunContext';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';
import { ToolError } from '@tools/result';

/**
 * Return the active RunContext's runtime host, throwing a ToolError if no
 * run is active or the launch had no host. Use from tools that need to
 * emit progress events.
 */
export function requireRuntimeHost(toolName: string): AgentRuntimeHost {
  const host = tryUseRunContext()?.runtimeHost;
  if (!host) {
    throw new ToolError(`${toolName} requires a tool runtime host.`);
  }
  return host;
}

/**
 * Return the active stream id and runtime host together, throwing a
 * ToolError if either is missing. Use from tools that need both a stream
 * to address (e.g. subscribe/approval) and a host to emit on.
 */
export function requireRunStream(toolName: string): {
  streamId: StreamTabId;
  runtimeHost: AgentRuntimeHost;
  context: RunContext;
} {
  const context = tryUseRunContext();
  if (!context?.streamId || !context.runtimeHost) {
    throw new ToolError(
      `${toolName} must be called from within an agent stream.`,
    );
  }
  return {
    streamId: context.streamId,
    runtimeHost: context.runtimeHost,
    context,
  };
}
