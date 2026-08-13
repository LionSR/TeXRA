/**
 * Tool-side helpers for reading the active RunContext.
 *
 * Centralizes the "look up a required field, throw a tool-friendly error
 * when missing" pattern that several tools used to spell out individually
 * with slightly different error wording.
 */

import {
  getRunContextInteractions,
  getRunContextStreamId,
  tryUseRunContext,
  type RunContext,
} from '@agent/runtime/RunContext';
import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import type { StreamTabId } from '@shared/schemas';
import { ToolError } from '@shared/schemas';

/**
 * Return the active RunContext's session host interactions, throwing a ToolError
 * if no run is active or the session has no interactions. Use from tools that
 * need to emit presentation events.
 */
export function requireInteractions(
  toolName: string,
  context: RunContext | undefined = tryUseRunContext(),
): SessionHostInteractions {
  const interactions = getRunContextInteractions(context);
  if (!interactions) {
    throw new ToolError(
      `${toolName} requires a session with host interactions.`,
    );
  }
  return interactions;
}

/**
 * Return the active stream id, throwing a ToolError if none is active. Use
 * from tools that address a stream (e.g. a goal keyed by stream id) but,
 * unlike {@link requireRunStream}, don't need host interactions to do so.
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
 * Return the active stream id and session host interactions together, throwing a
 * ToolError if either is missing. Use from tools that need both a stream
 * to address (e.g. subscribe/approval) and interactions to emit on.
 */
export function requireRunStream(
  toolName: string,
  context: RunContext | undefined = tryUseRunContext(),
): {
  streamId: StreamTabId;
  interactions: SessionHostInteractions;
  context: RunContext;
} {
  const streamId = getRunContextStreamId(context);
  const interactions = getRunContextInteractions(context);
  if (!context || !streamId || !interactions) {
    throw new ToolError(
      `${toolName} must be called from within an agent stream.`,
    );
  }
  return {
    streamId,
    interactions,
    context,
  };
}
