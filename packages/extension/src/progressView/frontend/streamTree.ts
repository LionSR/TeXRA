import type { StreamTabInfo } from '@shared/schemas';

export type StreamTreeExpansionOverride = 'expanded' | 'collapsed';

interface StreamTreeInputs {
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
