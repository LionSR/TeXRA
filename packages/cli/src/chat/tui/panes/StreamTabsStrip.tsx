import { Box, Text } from 'ink';

import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

import { cliState, type StreamSlice } from '../state/cliState';
import { orderedDescendantsFromSlice } from '../state/focusCycle';
import { useSignal } from '../state/useSignal';

export interface StreamTabDisplayItem {
  readonly id: StreamTabId | 'ellipsis';
  readonly label: string;
  readonly active: boolean;
  readonly running: boolean;
  readonly status?: string;
}

const MAX_LABEL_WIDTH = 18;

function statusLabel(status: string | undefined): string | undefined {
  switch (status) {
    case STREAM_STATUS.INITIALIZING:
      return 'starting';
    case STREAM_STATUS.RUNNING:
      return 'running';
    case STREAM_STATUS.WAITING:
      return 'idle';
    case STREAM_STATUS.STOPPED:
      return 'stopped';
    case STREAM_STATUS.READY:
      return 'ready';
    default:
      return status;
  }
}

function truncate(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) return value;
  if (maxWidth <= 1) return '…';
  return `${value.slice(0, maxWidth - 1)}…`;
}

function childLabel(parent: StreamSlice | undefined, id: StreamTabId): string {
  const child = [
    ...(parent?.activeSubagents ?? []),
    ...(parent?.activeProcesses ?? []),
  ].find((entry) => entry.childStreamId === id);
  return child?.agentName || child?.toolName || child?.executionId || id;
}

function activeTreeRoot(
  activeStreamId: StreamTabId | undefined,
  parentStream: ReadonlyMap<StreamTabId, StreamTabId>,
  streams: ReadonlyMap<StreamTabId, StreamSlice>,
): StreamTabId | undefined {
  if (!activeStreamId) return streams.keys().next().value;
  return parentStream.get(activeStreamId) ?? activeStreamId;
}

function collapseMiddle(
  items: readonly StreamTabDisplayItem[],
  width: number,
): readonly StreamTabDisplayItem[] {
  const total = items.reduce((sum, item) => sum + item.label.length + 8, 0);
  if (total <= width || items.length <= 4) return items;
  const activeIndex = items.findIndex((item) => item.active);
  const keep = new Set([0, items.length - 1]);
  if (activeIndex > 0 && activeIndex < items.length - 1) {
    keep.add(activeIndex);
  } else {
    keep.add(1);
  }

  const out: StreamTabDisplayItem[] = [];
  let elided = false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (keep.has(i)) {
      if (elided) {
        out.push({
          id: 'ellipsis',
          label: '…',
          active: false,
          running: false,
        });
        elided = false;
      }
      out.push(item);
    } else {
      elided = true;
    }
  }
  return out;
}

export function streamTabsDisplayItems(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly width: number;
}): readonly StreamTabDisplayItem[] {
  const root = activeTreeRoot(
    init.activeStreamId,
    init.parentStream,
    init.streams,
  );
  if (!root) return [];
  const rootSlice = init.streams.get(root);
  const ordered = [root, ...orderedDescendantsFromSlice(rootSlice)].filter(
    (id) => init.streams.has(id),
  );
  if (ordered.length < 2) return [];
  const items = ordered.map((id): StreamTabDisplayItem => {
    const slice = init.streams.get(id);
    const status = statusLabel(slice?.status);
    return {
      id,
      label: truncate(
        id === root ? 'main' : childLabel(rootSlice, id),
        MAX_LABEL_WIDTH,
      ),
      active: id === init.activeStreamId,
      running: slice?.status === STREAM_STATUS.RUNNING,
      status,
    };
  });
  return collapseMiddle(items, init.width);
}

export function streamTabSegmentText(item: StreamTabDisplayItem): string {
  if (item.id === 'ellipsis') return '…';
  const label = item.active ? `[${item.label}]` : item.label;
  const running = item.running ? '*' : '';
  const status =
    !item.active && item.status && item.status !== 'running'
      ? `(${item.status})`
      : '';
  return `${label}${running}${status}`;
}

export function StreamTabsStrip(props: {
  readonly width: number;
}): React.JSX.Element | null {
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const parentStream = useSignal(cliState.parentStream);
  const items = streamTabsDisplayItems({
    activeStreamId,
    streams,
    parentStream,
    width: props.width,
  });
  if (items.length === 0) return null;

  return (
    <Box paddingX={1}>
      {items.map((item, index) => (
        <Text
          key={`${item.id}:${index}`}
          bold={item.active}
          dimColor={!item.active && !item.running}
          color={item.active ? 'cyan' : item.running ? 'green' : undefined}
        >
          {index === 0 ? '' : ' '}
          {streamTabSegmentText(item)}
        </Text>
      ))}
    </Box>
  );
}
