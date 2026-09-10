/**
 * Tool-side helpers for reading the active RunContext.
 *
 * Centralizes the "look up a required field, throw a tool-friendly error
 * when missing" pattern that several tools used to spell out individually
 * with slightly different error wording.
 */

import {
  getRunContextInteractions,
  getRunContextRunId,
  tryUseRunContext,
  type RunContext,
} from '@agent/runtime/RunContext';
import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import type { RunId } from '@shared/schemas';
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
 * unlike {@link requireLiveRun}, don't need host interactions to do so.
 */
export function requireRunId(
  toolName: string,
  context: RunContext | undefined = tryUseRunContext(),
): RunId {
  const runId = getRunContextRunId(context);
  if (!runId) {
    throw new ToolError(`${toolName} requires an active stream context.`);
  }
  return runId;
}

/**
 * Return the active stream id and session host interactions together, throwing a
 * ToolError if either is missing. Use from tools that need both a stream
 * to address (e.g. subscribe/approval) and interactions to emit on.
 */
export function requireLiveRun(
  toolName: string,
  context: RunContext | undefined = tryUseRunContext(),
): {
  runId: RunId;
  interactions: SessionHostInteractions;
  context: RunContext;
} {
  const runId = getRunContextRunId(context);
  const interactions = getRunContextInteractions(context);
  if (!context || !runId || !interactions) {
    throw new ToolError(
      `${toolName} must be called from within an agent stream.`,
    );
  }
  return {
    runId,
    interactions,
    context,
  };
}
