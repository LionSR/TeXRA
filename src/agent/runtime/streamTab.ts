import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { getCleanAgentName } from '@shared/schemas';

/**
 * Mint the opaque stream tab id for a new run: `${name}#${executionId}`.
 *
 * Single owner of the format for every run that gets a tab: a native run
 * passes its agent identifier, a child run launched by a tool passes that
 * tool's stream prefix (e.g. {@link BASH_CHILD_STREAM_PREFIX}). Disjoint
 * namespaces, one wire format — the one {@link getStreamTabDisplayName} below
 * reads back. `getCleanAgentName` normalizes an `<source>:<agent>` identifier
 * and returns anything else, tool prefixes included, unchanged.
 *
 * The id is an opaque handle — nothing parses it back to address a run.
 * Uniqueness comes from the executionId suffix; the name prefix is
 * human-orienting only. Existing runs are addressed by the `streamId` stamped
 * on their execution metadata at registration, never by re-deriving this
 * format.
 */
export function getStreamTabId(
  name: string,
  options: { executionId: ExecutionId },
): StreamTabId {
  return `${getCleanAgentName(name)}#${options.executionId}`;
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
