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
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streamId: StreamTabId;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): string {
  const parentStreamId = init.parentStream.get(init.streamId);
  if (!parentStreamId) return 'main';
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

export function streamTreeViews(
  init: StreamTreeViewInput,
): readonly StreamView[] {
  const ordered = streamTreeEntries(init);
  if (ordered.length < 2) return [];
  return ordered.map((entry) =>
    streamViewForId({
      activeStreamId: init.activeStreamId,
      childStreamEntries: init.childStreamEntries,
      parentStream: init.parentStream,
      streamId: entry.id,
      streams: init.streams,
    }),
  );
}
