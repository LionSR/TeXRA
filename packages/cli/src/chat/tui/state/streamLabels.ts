// Shared display labels for stream-scoped CLI controls.

// Local imports - shared schemas
import type { StreamTabId } from '@shared/schemas';

// Local imports - CLI state
import type { StreamSlice } from './cliState';

export function childStreamDisplayLabel(
  parent:
    | Pick<StreamSlice, 'activeSubagents' | 'activeProcesses' | 'childStreams'>
    | undefined,
  streamId: StreamTabId,
): string {
  const child = [
    ...(parent?.activeSubagents ?? []),
    ...(parent?.activeProcesses ?? []),
    ...(parent?.childStreams ?? []),
  ].find((entry) => entry.childStreamId === streamId);
  return child?.agentName || child?.toolName || child?.executionId || streamId;
}

export function streamScopeDisplayLabel(init: {
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streamId: StreamTabId;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): string {
  const parentStreamId = init.parentStream.get(init.streamId);
  if (!parentStreamId) return 'main';
  return childStreamDisplayLabel(
    init.streams.get(parentStreamId),
    init.streamId,
  );
}
