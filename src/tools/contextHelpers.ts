/**
 * Tool-side helpers for reading the active RunContext.
 *
 * Centralizes the "look up a required field, throw a tool-friendly error
 * when missing" pattern that several tools used to spell out individually
 * with slightly different error wording.
 */

import {
  getRunContextRuntimeHost,
  getRunContextStreamId,
  tryUseRunContext,
  type RunContext,
} from '@agent/runtime/RunContext';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';
import { ToolError } from '@shared/schemas/toolResult';

/**
 * Return the active RunContext's runtime host, throwing a ToolError if no
 * run is active or the launch had no host. Use from tools that need to
 * emit progress events.
 */
export function requireRuntimeHost(
  toolName: string,
  context: RunContext | undefined = tryUseRunContext(),
): AgentRuntimeHost {
  const host = getRunContextRuntimeHost(context);
  if (!host) {
    throw new ToolError(`${toolName} requires a tool runtime host.`);
  }
  return host;
}

/**
 * Return the active stream id, throwing a ToolError if none is active. Use
 * from tools that address a stream (e.g. a goal keyed by stream id) but,
 * unlike {@link requireRunStream}, don't need the runtime host to do so.
 */
export function requireStreamId(
  toolName: string,
  context: RunContext | undefined = tryUseRunContext(),
): StreamTabId {
  const streamId = getRunContextStreamId(context);
  if (!streamId) {
    throw new ToolError(`${toolName} requires an active stream context.`);
  }
  return streamId;
}

/**
 * Return the active stream id and runtime host together, throwing a
 * ToolError if either is missing. Use from tools that need both a stream
 * to address (e.g. subscribe/approval) and a host to emit on.
 */
export function requireRunStream(
  toolName: string,
  context: RunContext | undefined = tryUseRunContext(),
): {
  streamId: StreamTabId;
  runtimeHost: AgentRuntimeHost;
  context: RunContext;
} {
  const streamId = getRunContextStreamId(context);
  const runtimeHost = getRunContextRuntimeHost(context);
  if (!context || !streamId || !runtimeHost) {
    throw new ToolError(
      `${toolName} must be called from within an agent stream.`,
    );
  }
  return {
    streamId,
    runtimeHost,
    context,
  };
}
