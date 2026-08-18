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
    readonly activeStreamId?: string | null;
  },
): StreamTreeProjection {
  const userOverrides = pruneStreamTreeUserOverrides(
    inputs.userOverrides,
    inputs.childStreamsByParent,
  );
  const parentByChild = parentByChildMap(inputs.childStreamsByParent);
  const approvalSignals = collectPendingApprovalSignals(
    parentByChild,
    inputs.pendingApprovalStreamIds ?? new Set(),
  );
  // Viewing a child (Background-tasks jump, or after an approval clears)
  // must keep its ancestor path open. Running siblings stay collapsed.
  const activeAncestors = collectAncestorIds(
    parentByChild,
    inputs.activeStreamId,
  );
  const expandedParents = new Set<string>();

  for (const parentId of inputs.childStreamsByParent.keys()) {
    if (
      userOverrides.get(parentId) === 'expanded' ||
      approvalSignals.expandParents.has(parentId) ||
      activeAncestors.has(parentId)
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

function parentByChildMap(
  childStreamsByParent: ReadonlyMap<string, readonly StreamTabInfo[]>,
): Map<string, string> {
  const parentByChild = new Map<string, string>();
  for (const [parentId, children] of childStreamsByParent) {
    for (const child of children) {
      parentByChild.set(child.name, parentId);
    }
  }
  return parentByChild;
}

function collectAncestorIds(
  parentByChild: ReadonlyMap<string, string>,
  streamId: string | null | undefined,
): Set<string> {
  const ancestors = new Set<string>();
  if (streamId == null || streamId === '') return ancestors;
  let current = parentByChild.get(streamId);
  while (current !== undefined && !ancestors.has(current)) {
    ancestors.add(current);
    current = parentByChild.get(current);
  }
  return ancestors;
}

/**
 * A pending approval on a hidden descendant is still blocking. Walk from each
 * pending stream up to the root so ancestors expand and show the same badge
 * the child row would have shown.
 */
function collectPendingApprovalSignals(
  parentByChild: ReadonlyMap<string, string>,
  pendingApprovalStreamIds: ReadonlySet<string>,
): { expandParents: Set<string>; badgeStreamIds: Set<string> } {
  const expandParents = new Set<string>();
  const badgeStreamIds = new Set(pendingApprovalStreamIds);
  for (const pendingId of pendingApprovalStreamIds) {
    for (const ancestor of collectAncestorIds(parentByChild, pendingId)) {
      expandParents.add(ancestor);
      badgeStreamIds.add(ancestor);
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
