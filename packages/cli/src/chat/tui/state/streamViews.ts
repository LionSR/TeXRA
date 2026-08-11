// Stream-scoped display projection for CLI controls. The authoritative state
// remains `StreamSlice` plus the child->parent edge map; this module owns the
// derived labels and active tree order so tabs, headers, and lists do not
// each rebuild them differently.

// Local imports - shared schemas
import type { RunIdentity, StreamTabId } from '@shared/schemas';

// Local imports - CLI state
import {
  childExecutionLabel,
  focusOrderDescendants,
  visibleSubagentRows,
  type ChildStreamEntries,
} from './childExecutions';
import type { StreamSlice } from './cliState';

export interface StreamView {
  readonly id: StreamTabId;
  readonly label: string;
  /** What owns the child stream, retained with the child execution. */
  readonly identity?: RunIdentity;
  readonly parentId?: StreamTabId;
  readonly parentLabel?: string;
  readonly slice: StreamSlice | undefined;
  readonly active: boolean;
}

export type ActiveStreamScope =
  | { readonly kind: 'none' }
  | { readonly kind: 'root'; readonly streamId: StreamTabId }
  | {
      readonly kind: 'child';
      readonly parentStreamId: StreamTabId;
      readonly streamId: StreamTabId;
    };

export interface ActiveStreamAncestor<T> {
  readonly streamId: StreamTabId;
  readonly value: T;
}

export interface ActiveStreamTreeEntry {
  readonly id: StreamTabId;
  readonly shortcutIndex?: number;
}

export function activeStreamScope(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
}): ActiveStreamScope {
  const activeStreamId = init.activeStreamId;
  if (!activeStreamId) return { kind: 'none' };

  const parentStreamId = init.parentStream.get(activeStreamId);
  return parentStreamId === undefined
    ? { kind: 'root', streamId: activeStreamId }
    : { kind: 'child', parentStreamId, streamId: activeStreamId };
}

export function activeStreamParentOrSelfId(init: {
  readonly activeStreamId: StreamTabId;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
}): StreamTabId;
export function activeStreamParentOrSelfId(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
}): StreamTabId | undefined;
export function activeStreamParentOrSelfId(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
}): StreamTabId | undefined {
  const scope = activeStreamScope(init);
  if (scope.kind === 'none') return undefined;
  return scope.kind === 'child' ? scope.parentStreamId : scope.streamId;
}

export function nearestActiveStreamAncestor<T>(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly values: ReadonlyMap<StreamTabId, T>;
  readonly canUseValue: (value: T, streamId: StreamTabId) => boolean;
}): ActiveStreamAncestor<T> | undefined {
  const activeStreamId = init.activeStreamId;
  if (activeStreamId === undefined) return undefined;

  const visited = new Set<StreamTabId>([activeStreamId]);
  let parentStreamId = init.parentStream.get(activeStreamId);
  while (parentStreamId && !visited.has(parentStreamId)) {
    visited.add(parentStreamId);
    const value = init.values.get(parentStreamId);
    if (value !== undefined && init.canUseValue(value, parentStreamId)) {
      return { streamId: parentStreamId, value };
    }
    parentStreamId = init.parentStream.get(parentStreamId);
  }
  return undefined;
}

function childStreamReferenceLabel(
  parentStreamId: StreamTabId,
  childStreamEntries: ChildStreamEntries,
  streams: ReadonlyMap<StreamTabId, StreamSlice>,
  streamId: StreamTabId,
): string {
  const child = visibleSubagentRows(
    parentStreamId,
    childStreamEntries,
    streams,
  ).find((entry) => entry.childStreamId === streamId);
  return child ? childExecutionLabel(child) : streamId;
}

export function streamDisplayLabel(init: {
  readonly childStreamEntries: ChildStreamEntries;
  /** Batch-resolved labels from {@link streamTreeViews}; single lookups compute on demand. */
  readonly labels?: ReadonlyMap<StreamTabId, string>;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streamId: StreamTabId;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): string {
  const parentStreamId = init.parentStream.get(init.streamId);
  if (!parentStreamId) return 'main';
  const precomputed = init.labels?.get(init.streamId);
  if (precomputed !== undefined) return precomputed;
  return childStreamReferenceLabel(
    parentStreamId,
    init.childStreamEntries,
    init.streams,
    init.streamId,
  );
}

export function streamViewForId(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly childStreamEntries: ChildStreamEntries;
  /** Batch-resolved labels from {@link streamTreeViews}; single lookups compute on demand. */
  readonly labels?: ReadonlyMap<StreamTabId, string>;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streamId: StreamTabId;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): StreamView {
  const parentId = init.parentStream.get(init.streamId);
  const childEntry = init.childStreamEntries.get(init.streamId);
  const liveSummary =
    childEntry?.kind === 'live' ? childEntry.summary : undefined;
  return {
    id: init.streamId,
    label: streamDisplayLabel(init),
    identity: liveSummary?.identity,
    parentId,
    parentLabel: parentId
      ? streamDisplayLabel({
          childStreamEntries: init.childStreamEntries,
          labels: init.labels,
          parentStream: init.parentStream,
          streamId: parentId,
          streams: init.streams,
        })
      : undefined,
    slice: init.streams.get(init.streamId),
    active: init.streamId === init.activeStreamId,
  };
}

interface StreamTreeViewInput {
  readonly activeStreamId: StreamTabId | undefined;
  readonly childStreamEntries: ChildStreamEntries;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly rootStreamId: StreamTabId | undefined;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}

export function streamTreeEntries(
  init: StreamTreeViewInput,
): readonly ActiveStreamTreeEntry[] {
  const root = init.rootStreamId;
  if (!root) return [];
  // Newest-first: focus order returns children oldest-first (retained order,
  // then creation order), so the child list and its
  // Alt+1..9 shortcuts read top-to-bottom from most to least recently
  // started, keeping the row a user is most likely watching near the top.
  const ordered = focusOrderDescendants(
    root,
    init.childStreamEntries,
    init.streams,
  ).toReversed();
  const out: ActiveStreamTreeEntry[] = [];
  if (init.streams.has(root)) out.push({ id: root });
  for (const [index, id] of ordered.entries()) {
    if (!init.streams.has(id)) continue;
    const position = index + 1;
    const shortcutIndex = position > 9 ? undefined : position;
    out.push({ id, shortcutIndex });
  }
  return out;
}

/**
 * Display labels for a batch of stream ids in one pass: grouping ids by
 * parent runs `visibleSubagentRows` once per parent rather than once per
 * child, so a wide child list costs one roster scan per distinct parent per
 * render instead of one per row. A parentless id gets no entry here —
 * `streamDisplayLabel` answers 'main' for it without consulting the map.
 */
function childStreamLabels(
  init: Pick<
    StreamTreeViewInput,
    'childStreamEntries' | 'parentStream' | 'streams'
  >,
  streamIds: readonly StreamTabId[],
): ReadonlyMap<StreamTabId, string> {
  const idsByParent = new Map<StreamTabId, StreamTabId[]>();
  for (const streamId of streamIds) {
    const parentStreamId = init.parentStream.get(streamId);
    if (!parentStreamId) continue;
    const bucket = idsByParent.get(parentStreamId);
    if (bucket) bucket.push(streamId);
    else idsByParent.set(parentStreamId, [streamId]);
  }
  const labels = new Map<StreamTabId, string>();
  for (const [parentStreamId, ids] of idsByParent) {
    const unresolved = new Set(ids);
    for (const child of visibleSubagentRows(
      parentStreamId,
      init.childStreamEntries,
      init.streams,
    )) {
      if (unresolved.delete(child.childStreamId)) {
        labels.set(child.childStreamId, childExecutionLabel(child));
      }
    }
    // Not on the parent's roster: the same fallback childStreamReferenceLabel
    // uses when its find misses.
    for (const streamId of unresolved) labels.set(streamId, streamId);
  }
  return labels;
}

export function streamTreeViews(
  init: StreamTreeViewInput,
): readonly StreamView[] {
  const ordered = streamTreeEntries(init);
  if (ordered.length < 2) return [];
  // Resolve every row's label in one pass: `visibleSubagentRows` scans the
  // full child-entry map, so looking it up per row (and again per parent
  // label) costs one scan per child per render.
  const labels = childStreamLabels(
    init,
    ordered.map((entry) => entry.id),
  );
  return ordered.map((entry) =>
    streamViewForId({
      activeStreamId: init.activeStreamId,
      childStreamEntries: init.childStreamEntries,
      labels,
      parentStream: init.parentStream,
      streamId: entry.id,
      streams: init.streams,
    }),
  );
}
