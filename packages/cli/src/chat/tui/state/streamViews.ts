// Stream-scoped display projection for CLI controls. The authoritative state
// remains `StreamSlice` plus the child->parent edge map; this module owns the
// derived labels and active tree order so tabs, headers, and pickers do not
// each rebuild them differently.

// Local imports - shared schemas
import type { ActiveChildInfo, StreamTabId } from '@shared/schemas';

// Local imports - CLI state
import { visibleSubagentRows } from './childStreamMerge';
import { orderedDescendantsFromTree } from './focusCycle';
import type { StreamSlice } from './cliState';

export interface StreamView {
  readonly id: StreamTabId;
  readonly label: string;
  readonly parentId?: StreamTabId;
  readonly parentLabel?: string;
  readonly slice: StreamSlice | undefined;
  readonly active: boolean;
  readonly shortcutIndex?: number;
}

export type ActiveStreamScope =
  | { readonly kind: 'none' }
  | { readonly kind: 'root'; readonly streamId: StreamTabId }
  | {
      readonly kind: 'child';
      readonly parentStreamId: StreamTabId;
      readonly streamId: StreamTabId;
    };

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

function childReferenceKey(child: ActiveChildInfo): string {
  return child.childStreamId ?? child.executionId;
}

function childReferenceLabel(child: ActiveChildInfo): string {
  return child.agentName || child.toolName || child.executionId;
}

const emptyChildReferenceSlice = {
  activeSubagents: [],
  childStreams: [],
} satisfies Pick<StreamSlice, 'activeSubagents' | 'childStreams'>;

export function childStreamReferenceLabel(
  parent:
    | Pick<StreamSlice, 'activeSubagents' | 'activeProcesses' | 'childStreams'>
    | undefined,
  streamId: StreamTabId,
): string {
  const child = [
    ...visibleSubagentRows(parent ?? emptyChildReferenceSlice),
    ...(parent?.activeProcesses ?? []),
  ].find((entry) => childReferenceKey(entry) === streamId);
  return child ? childReferenceLabel(child) : streamId;
}

export function streamDisplayLabel(init: {
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streamId: StreamTabId;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): string {
  const parentStreamId = init.parentStream.get(init.streamId);
  if (!parentStreamId) return 'main';
  return childStreamReferenceLabel(
    init.streams.get(parentStreamId),
    init.streamId,
  );
}

export function streamViewForId(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly shortcutIndex?: number;
  readonly streamId: StreamTabId;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): StreamView {
  const parentId = init.parentStream.get(init.streamId);
  return {
    id: init.streamId,
    label: streamDisplayLabel(init),
    parentId,
    parentLabel: parentId
      ? streamDisplayLabel({
          parentStream: init.parentStream,
          streamId: parentId,
          streams: init.streams,
        })
      : undefined,
    slice: init.streams.get(init.streamId),
    active: init.streamId === init.activeStreamId,
    shortcutIndex: init.shortcutIndex,
  };
}

interface OrderedStreamViewInput {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}

function activeTreeRoot(init: OrderedStreamViewInput): StreamTabId | undefined {
  return activeStreamParentOrSelfId(init) ?? init.streams.keys().next().value;
}

function orderedStreamTree(init: {
  readonly root: StreamTabId;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): readonly Pick<StreamView, 'id' | 'shortcutIndex'>[] {
  const ordered = orderedDescendantsFromTree({
    parent: init.root,
    parentSlice: init.streams.get(init.root),
    parentStream: init.parentStream,
    streams: init.streams,
  });
  const out: Pick<StreamView, 'id' | 'shortcutIndex'>[] = [];
  if (init.streams.has(init.root)) out.push({ id: init.root });
  for (const [index, id] of ordered.entries()) {
    if (!init.streams.has(id)) continue;
    const position = index + 1;
    const shortcutIndex = position <= 0 || position > 9 ? undefined : position;
    out.push({ id, shortcutIndex });
  }
  return out;
}

export function activeStreamTreeViews(
  init: OrderedStreamViewInput,
): readonly StreamView[] {
  const root = activeTreeRoot(init);
  if (!root) return [];
  const ordered = orderedStreamTree({
    root,
    parentStream: init.parentStream,
    streams: init.streams,
  });
  if (ordered.length < 2) return [];
  return ordered.map((entry) =>
    streamViewForId({
      activeStreamId: init.activeStreamId,
      parentStream: init.parentStream,
      shortcutIndex: entry.shortcutIndex,
      streamId: entry.id,
      streams: init.streams,
    }),
  );
}
