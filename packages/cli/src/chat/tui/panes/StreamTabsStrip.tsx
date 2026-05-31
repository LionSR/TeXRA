import { Box, Text } from 'ink';

import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

import { cliState, type StreamSlice } from '../state/cliState';
import { orderedDescendantsFromTree } from '../state/focusCycle';
import {
  childStreamDisplayLabel,
  streamScopeDisplayLabel,
} from '../state/streamLabels';
import { useSignal } from '../state/useSignal';

export interface StreamTabDisplayItem {
  readonly id: StreamTabId | 'ellipsis';
  readonly label: string;
  readonly active: boolean;
  readonly running: boolean;
  readonly shortcutIndex?: number;
  readonly status?: string;
}

const MAX_LABEL_WIDTH = 18;

interface OrderedStreamTab {
  readonly id: StreamTabId;
  readonly shortcutIndex?: number;
}

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

function orderedStreamTree(init: {
  readonly root: StreamTabId;
  readonly rootSlice: StreamSlice | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): OrderedStreamTab[] {
  const ordered = orderedDescendantsFromTree({
    parent: init.root,
    parentSlice: init.rootSlice,
    parentStream: init.parentStream,
    streams: init.streams,
  });
  const out: OrderedStreamTab[] = [];
  if (init.streams.has(init.root)) out.push({ id: init.root });
  for (const [index, id] of ordered.entries()) {
    if (!init.streams.has(id)) continue;
    out.push({ id, shortcutIndex: streamTabShortcutIndex(index + 1) });
  }
  return out;
}

export function streamTabSegmentText(item: StreamTabDisplayItem): string {
  if (item.id === 'ellipsis') return '…';
  const labeled =
    item.shortcutIndex === undefined
      ? item.label
      : `${item.shortcutIndex}:${item.label}`;
  const label = item.active ? `[${labeled}]` : labeled;
  const running = item.running ? '*' : '';
  const status =
    item.status &&
    item.status !== 'running' &&
    (!item.active || item.status === 'stopped')
      ? `(${item.status})`
      : '';
  return `${label}${running}${status}`;
}

export function streamTabsLineText(
  items: readonly StreamTabDisplayItem[],
  width?: number,
): string {
  return streamTabsLineSegments(items, width)
    .map((segment) => `${segment.leadingSpace ? ' ' : ''}${segment.text}`)
    .join('');
}

export interface StreamTabLineSegment {
  readonly item: StreamTabDisplayItem;
  readonly leadingSpace: boolean;
  readonly text: string;
}

export function streamTabsLineSegments(
  items: readonly StreamTabDisplayItem[],
  width?: number,
): readonly StreamTabLineSegment[] {
  let remaining = width === undefined ? Number.POSITIVE_INFINITY : width;
  if (remaining <= 0) return [];
  const segments: StreamTabLineSegment[] = [];
  for (const [index, item] of items.entries()) {
    const leadingSpace = index > 0;
    const text = streamTabSegmentText(item);
    const totalWidth = text.length + (leadingSpace ? 1 : 0);
    if (totalWidth <= remaining) {
      segments.push({ item, leadingSpace, text });
      remaining -= totalWidth;
      continue;
    }

    const textWidth = remaining - (leadingSpace ? 1 : 0);
    if (textWidth <= 0) break;
    segments.push({
      item,
      leadingSpace,
      text: textWidth <= 1 ? '…' : `${text.slice(0, textWidth - 1)}…`,
    });
    break;
  }
  return segments;
}

function streamTabsTextLength(items: readonly StreamTabDisplayItem[]): number {
  return streamTabsLineText(items).length;
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
  const usableWidth = Math.max(0, width - 2);
  if (streamTabsTextLength(items) <= usableWidth || items.length <= 2) {
    return items;
  }
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

function streamTabShortcutIndex(position: number): number | undefined {
  if (position <= 0 || position > 9) return undefined;
  return position;
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
  const ordered = orderedStreamTree({
    root,
    rootSlice,
    parentStream: init.parentStream,
    streams: init.streams,
  });
  if (ordered.length < 2) return [];
  const items = ordered.map((tab): StreamTabDisplayItem => {
    const { id } = tab;
    const slice = init.streams.get(id);
    const status = statusLabel(slice?.status);
    return {
      id,
      label: truncate(
        id === root
          ? streamScopeDisplayLabel({
              parentStream: init.parentStream,
              streamId: id,
              streams: init.streams,
            })
          : childStreamDisplayLabel(rootSlice, id),
        MAX_LABEL_WIDTH,
      ),
      active: id === init.activeStreamId,
      running: slice?.status === STREAM_STATUS.RUNNING,
      shortcutIndex: tab.shortcutIndex,
      status,
    };
  });
  return collapseMiddle(items, init.width);
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
  const segments = streamTabsLineSegments(items, Math.max(0, props.width - 2));

  return (
    <Box
      flexDirection="row"
      flexWrap="nowrap"
      height={1}
      minWidth={0}
      overflowY="hidden"
      paddingX={1}
    >
      {segments.map((segment, index) => (
        <Text
          key={`${segment.item.id}:${index}`}
          bold={segment.item.active}
          dimColor={!segment.item.active && !segment.item.running}
          color={
            segment.item.active
              ? 'cyan'
              : segment.item.running
                ? 'green'
                : undefined
          }
        >
          {segment.leadingSpace ? ' ' : ''}
          {segment.text}
        </Text>
      ))}
    </Box>
  );
}
