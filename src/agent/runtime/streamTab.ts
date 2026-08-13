import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { getCleanAgentName } from '@shared/schemas/agent';

/**
 * Mint the opaque stream tab id for a new run: `${name}#${executionId}`.
 *
 * The id is an opaque handle — nothing parses it back. Uniqueness comes from
 * the executionId suffix; the name prefix is human-orienting only. Existing
 * runs are addressed by the `streamId` stamped on their execution metadata
 * at registration, never by re-deriving this format.
 */
export function getStreamTabId(
  agent: string,
  options: { executionId: ExecutionId },
): StreamTabId {
  return `${getCleanAgentName(agent)}#${options.executionId}`;
}

/**
 * The human-orienting name prefix of a stream tab id, for display only.
 *
 * This does not violate "nothing parses it back": that rule is about
 * *addressing* a run — resolving identity or locating an execution by
 * re-deriving the format, which is what the deleted legacy resolver did.
 * Reading the prefix that {@link getStreamTabId} deliberately put there
 * "human-orienting only" feeds no lookup and no identity decision; it just
 * avoids showing a raw hex suffix to a reader. The full id stays available
 * as `StreamTabInfo.name` for tooltips and copy.
 *
 * Callers must have no better source. A resolved {@link RunIdentity} always
 * wins — see `buildStreamTabInfo`, whose only use of this is the legacy /
 * never-resolved case.
 */
export function getStreamTabDisplayName(streamId: string): string {
  // The *first* '#' is the separator: the format is `${name}#${executionId}`,
  // so anything after it belongs to the executionId. Splitting on the last
  // one would leak part of an executionId that contains '#', and would give
  // that run a different label than the same agent's resolved run.
  // (Mirrors `getCleanAgentName`, which splits on the first ':'.)
  const separator = streamId.indexOf('#');
  // No separator, or a leading '#', means this is not a minted id — show it
  // verbatim rather than silently rendering an empty label.
  if (separator <= 0) return streamId;
  return streamId.slice(0, separator);
}

/** Stream-id prefix minted for a background shell child (`src/tools/bash.ts`). */
export const BASH_CHILD_STREAM_PREFIX = 'bash@tool';

/**
 * Whether `streamId` was minted for a background shell child.
 *
 * For any live run the authority is `RunIdentity` (`{ kind: 'process' }`). This
 * answers the one question identity cannot: whether a stream found *on disk*
 * that predates identity stamping (#9705) was a background shell. Its sole
 * caller is `SessionStores.sweepEphemeralStreams`, and it is a legacy-data
 * question rather than a runtime one — no run is addressed, resolved, or
 * classified through it, so the rule that identity is never reconstructed from
 * a stream id (#9755) still governs all of those.
 *
 * The match is exact, not heuristic: {@link BASH_CHILD_STREAM_PREFIX} is the
 * prefix's only minter, and no agent can carry it — `getCleanAgentName` splits
 * a roster name at ':' and a bare agent name has no '@'.
 *
 * Introduced 2026-08-08 as a compatibility reader. Retire it once no reachable
 * workspace can hold a stream written before identity stamping shipped
 * (#9705, 2026-08-04) — i.e. from 2026-11-04, when the compatibility window
 * closes — and let the sweep read `RunIdentity` alone.
 */
export function isBackgroundShellStream(streamId: StreamTabId): boolean {
  return getStreamTabDisplayName(streamId) === BASH_CHILD_STREAM_PREFIX;
}
