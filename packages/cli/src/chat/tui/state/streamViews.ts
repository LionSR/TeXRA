// Stream-scoped display projection for CLI controls. Display fields come from
// the shared `buildStreamTabInfo` — the same builder the extension and desktop
// tabs use, so one run never carries two names — and this module owns only the
// CLI's own concerns: the active tree order, focus scope, and ancestor walks.

// Local imports - shared schemas
import { buildStreamTabInfo } from '@controllers/session/streamTabInfo';
import type { StreamTabId, StreamTabInfo } from '@shared/schemas';

// Local imports - CLI state
import {
  focusOrderDescendants,
  streamMetadataFor,
  visibleSubagentRows,
  type ChildRosters,
} from './childExecutions';
import type { StreamSlice } from './cliState';

/** The root conversation's own label — it is the session, not a tab. */
const ROOT_STREAM_LABEL = 'main';

export interface StreamView {
  readonly id: StreamTabId;
  /** Shared tab projection: label, identity, model label, worktree, remoteness.
   *  Absent only when no session state is bound (nothing has attached yet). */
  readonly info?: StreamTabInfo;
  readonly label: string;
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

/**
 * The shared tab projection for one stream. Its own metadata is the identity
 * authority; the parent's roster row is the fallback for a child whose
 * `run.start` has not landed yet (`child.activity` can arrive first — the
 * `roster-first` child-event order).
 */
function streamTabInfoFor(init: {
  readonly childRosters: ChildRosters;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streamId: StreamTabId;
}): StreamTabInfo | undefined {
  const metadata = streamMetadataFor(init.streamId);
  if (!metadata) return undefined;
  const parentStreamId = init.parentStream.get(init.streamId);
  const identity =
    metadata.identity ??
    (parentStreamId
      ? visibleSubagentRows(parentStreamId, init.childRosters).find(
          (child) => child.childStreamId === init.streamId,
        )?.identity
      : undefined);
  return buildStreamTabInfo({
    streamId: init.streamId,
    metadata: identity ? { ...metadata, identity } : metadata,
  });
}

export function streamDisplayLabel(init: {
  readonly childRosters: ChildRosters;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streamId: StreamTabId;
}): string {
  if (!init.parentStream.get(init.streamId)) return ROOT_STREAM_LABEL;
  // With no session state bound (nothing has attached yet) the id is all
  // there is to say.
  return streamTabInfoFor(init)?.label ?? init.streamId;
}

export function streamViewForId(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly childRosters: ChildRosters;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streamId: StreamTabId;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): StreamView {
  const parentId = init.parentStream.get(init.streamId);
  return {
    id: init.streamId,
    info: streamTabInfoFor(init),
    label: streamDisplayLabel(init),
    parentId,
    parentLabel: parentId
      ? streamDisplayLabel({
          childRosters: init.childRosters,
          parentStream: init.parentStream,
          streamId: parentId,
        })
      : undefined,
    slice: init.streams.get(init.streamId),
    active: init.streamId === init.activeStreamId,
  };
}

interface StreamTreeViewInput {
  readonly activeStreamId: StreamTabId | undefined;
  readonly childRosters: ChildRosters;
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
    init.childRosters,
    init.parentStream,
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
      childRosters: init.childRosters,
      parentStream: init.parentStream,
      streamId: entry.id,
      streams: init.streams,
    }),
  );
}
