import {
  DEFAULT_STREAM_METADATA_STATUS,
  type StreamState,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import { isInFlightPhase } from '@shared/streams/streamStatus';

export type StreamBranchActivity = 'active' | 'finished' | 'unknown';
export type StreamTreeExpansionOverride = 'expanded' | 'collapsed';

interface StreamTreeInputs {
  readonly streamStates: ReadonlyMap<StreamTabId, StreamState>;
  readonly childStreamsByParent: ReadonlyMap<string, readonly StreamTabInfo[]>;
}

export interface StreamTreeProjection {
  readonly expandedParents: Set<string>;
  readonly approvalBadgeStreamIds: Set<string>;
  readonly userOverrides: Map<string, StreamTreeExpansionOverride>;
}

export function computeStreamTreeProjection(
  inputs: StreamTreeInputs & {
    readonly userOverrides: ReadonlyMap<string, StreamTreeExpansionOverride>;
    readonly pendingApprovalStreamIds?: ReadonlySet<string>;
  },
): StreamTreeProjection {
  const userOverrides = pruneStreamTreeUserOverrides(
    inputs.userOverrides,
    inputs.childStreamsByParent,
  );
  const approvalSignals = collectPendingApprovalSignals(
    inputs.childStreamsByParent,
    inputs.pendingApprovalStreamIds ?? new Set(),
  );
  const expandedParents = new Set<string>();

  for (const parentId of inputs.childStreamsByParent.keys()) {
    if (
      userOverrides.get(parentId) === 'expanded' ||
      approvalSignals.expandParents.has(parentId)
    ) {
      expandedParents.add(parentId);
    }
  }

  return {
    expandedParents,
    approvalBadgeStreamIds: approvalSignals.badgeStreamIds,
    userOverrides,
  };
}

/**
 * A pending approval on a hidden descendant is still blocking. Walk from each
 * pending stream up to the root so ancestors expand and show the same badge
 * the child row would have shown.
 */
function collectPendingApprovalSignals(
  childStreamsByParent: ReadonlyMap<string, readonly StreamTabInfo[]>,
  pendingApprovalStreamIds: ReadonlySet<string>,
): { expandParents: Set<string>; badgeStreamIds: Set<string> } {
  const parentByChild = new Map<string, string>();
  for (const [parentId, children] of childStreamsByParent) {
    for (const child of children) {
      parentByChild.set(child.name, parentId);
    }
  }

  const expandParents = new Set<string>();
  const badgeStreamIds = new Set(pendingApprovalStreamIds);
  for (const pendingId of pendingApprovalStreamIds) {
    const seen = new Set<string>();
    let current = parentByChild.get(pendingId);
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      expandParents.add(current);
      badgeStreamIds.add(current);
      current = parentByChild.get(current);
    }
  }
  return { expandParents, badgeStreamIds };
}

function pruneStreamTreeUserOverrides(
  userOverrides: ReadonlyMap<string, StreamTreeExpansionOverride>,
  childStreamsByParent: ReadonlyMap<string, readonly StreamTabInfo[]>,
): Map<string, StreamTreeExpansionOverride> {
  const next = new Map<string, StreamTreeExpansionOverride>();
  for (const [parentId, override] of userOverrides) {
    if (childStreamsByParent.has(parentId)) next.set(parentId, override);
  }
  return next;
}

/**
 * Classify an entire child branch, not just the direct row. Absent entries in
 * `streamStates` are `unknown` so a brand-new child is not treated as
 * finished before it reports a lifecycle signal.
 */
export function getStreamBranchActivity(
  inputs: StreamTreeInputs,
  streamId: StreamTabId,
  visited: ReadonlySet<string> = new Set(),
  cache: Map<StreamTabId, StreamBranchActivity> = new Map(),
): StreamBranchActivity {
  if (visited.has(streamId)) {
    return classifyStreamActivity(inputs.streamStates, streamId);
  }

  const cached = cache.get(streamId);
  if (cached) return cached;

  const ownActivity = classifyStreamActivity(inputs.streamStates, streamId);
  if (ownActivity === 'active') {
    cache.set(streamId, 'active');
    return 'active';
  }

  const nextVisited = new Set(visited);
  nextVisited.add(streamId);

  let anyUnknown = ownActivity === 'unknown';
  const children = inputs.childStreamsByParent.get(streamId) ?? [];
  for (const child of children) {
    const childActivity = getStreamBranchActivity(
      inputs,
      child.name,
      nextVisited,
      cache,
    );
    if (childActivity === 'active') {
      cache.set(streamId, 'active');
      return 'active';
    }
    if (childActivity === 'unknown') anyUnknown = true;
  }

  const activity = anyUnknown ? 'unknown' : 'finished';
  cache.set(streamId, activity);
  return activity;
}

function classifyStreamActivity(
  streamStates: ReadonlyMap<StreamTabId, StreamState>,
  streamId: StreamTabId,
): StreamBranchActivity {
  const status = streamStates.get(streamId)?.status;
  if (status === undefined) return 'unknown';
  const phase = status === DEFAULT_STREAM_METADATA_STATUS ? undefined : status;
  return isInFlightPhase(phase) ? 'active' : 'finished';
}
