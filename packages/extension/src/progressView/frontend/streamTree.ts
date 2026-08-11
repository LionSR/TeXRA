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
  readonly branchActivityByStream: Map<StreamTabId, StreamBranchActivity>;
  readonly userOverrides: Map<string, StreamTreeExpansionOverride>;
}

export function computeStreamTreeProjection(
  inputs: StreamTreeInputs & {
    readonly userOverrides: ReadonlyMap<string, StreamTreeExpansionOverride>;
  },
): StreamTreeProjection {
  const branchActivityByStream = new Map<StreamTabId, StreamBranchActivity>();
  const userOverrides = pruneStreamTreeUserOverrides(
    inputs.userOverrides,
    inputs.childStreamsByParent,
  );
  const expandedParents = new Set<string>();

  for (const [parentId, children] of inputs.childStreamsByParent) {
    if (
      shouldExpandStreamParent(
        inputs,
        parentId,
        children,
        userOverrides,
        branchActivityByStream,
      )
    ) {
      expandedParents.add(parentId);
    }
  }

  return {
    expandedParents,
    branchActivityByStream,
    userOverrides,
  };
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
 * `streamStates` are `unknown` so expansion can wait for a real lifecycle
 * signal instead of immediately treating a new child as finished.
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

function shouldExpandStreamParent(
  inputs: StreamTreeInputs,
  parentId: string,
  children: readonly StreamTabInfo[],
  userOverrides: ReadonlyMap<string, StreamTreeExpansionOverride>,
  cache: Map<StreamTabId, StreamBranchActivity>,
): boolean {
  const override = userOverrides.get(parentId);
  if (override) return override === 'expanded';

  return children.some(
    (child) =>
      getStreamBranchActivity(
        inputs,
        child.name,
        new Set([parentId]),
        cache,
      ) !== 'finished',
  );
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
