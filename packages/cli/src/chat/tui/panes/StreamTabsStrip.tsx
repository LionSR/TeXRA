import { Box, Text } from 'ink';

import {
  isActivePhase,
  isTerminalOutcomePhase,
} from '@common/constants/streamStatus';
import type { StreamTabId } from '@shared/schemas';
import { formatStreamStatusLabel } from '@shared/streams/streamStatusDisplay';

import { textDisplayWidth, truncateToWidth } from '../render/terminalText';
import {
  activeStreamId as activeStreamIdSignal,
  streams as streamsSignal,
  type StreamSlice,
} from '../state/cliState';
import {
  childStreamEntries as childStreamEntriesSignal,
  parentStream as parentStreamSignal,
  type ChildStreamEntries,
} from '../state/childExecutions';
import { activeStreamTreeViews } from '../state/streamViews';
import { useSignal } from '../state/useSignal';

export interface StreamTabDisplayItem {
  readonly id: StreamTabId | 'ellipsis';
  readonly label: string;
  readonly active: boolean;
  readonly running: boolean;
  readonly shortcutIndex?: number;
  readonly status?: string;
  /**
   * Whether the run has ended with a canonical outcome. WAITING remains
   * in-flight and is intentionally excluded so an active waiting tab stays
   * unsuffixed.
   */
  readonly ended?: boolean;
}

const MAX_LABEL_WIDTH = 18;

export function streamTabSegmentText(item: StreamTabDisplayItem): string {
  if (item.id === 'ellipsis') return '…';
  const labeled =
    item.shortcutIndex === undefined
      ? item.label
      : `${item.shortcutIndex}:${item.label}`;
  const label = item.active ? `[${labeled}]` : labeled;
  const running = item.running ? '*' : '';
  // Inactive tabs surface any non-running status; the active tab additionally
  // surfaces a terminal outcome so a stream that ends is not visually
  // indistinguishable from one still running.
  const status =
    item.status && item.status !== 'running' && (!item.active || item.ended)
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

const ELLIPSIS_TAB_ITEM: StreamTabDisplayItem = {
  id: 'ellipsis',
  label: '…',
  active: false,
  running: false,
};

function activeAnchoredItems(
  items: readonly StreamTabDisplayItem[],
  activeIndex: number,
): readonly StreamTabDisplayItem[] {
  const activeItem = items[activeIndex];
  const lastItem = items.at(-1);
  if (!activeItem) return items;
  const out: StreamTabDisplayItem[] = [];
  if (activeIndex > 0) {
    out.push(items[0]);
    if (activeIndex > 1) out.push(ELLIPSIS_TAB_ITEM);
  }
  out.push(activeItem);
  if (lastItem && activeIndex < items.length - 1) {
    if (activeIndex < items.length - 2) out.push(ELLIPSIS_TAB_ITEM);
    out.push(lastItem);
  }
  return out;
}

function buildLineSegments(
  items: readonly StreamTabDisplayItem[],
  width?: number,
): readonly StreamTabLineSegment[] {
  let remaining = width === undefined ? Number.POSITIVE_INFINITY : width;
  if (remaining <= 0) return [];
  const segments: StreamTabLineSegment[] = [];
  for (const [index, item] of items.entries()) {
    const leadingSpace = index > 0;
    const text = streamTabSegmentText(item);
    const totalWidth = textDisplayWidth(text) + (leadingSpace ? 1 : 0);
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
      text: truncateToWidth(text, textWidth),
    });
    break;
  }
  return segments;
}

export function streamTabsLineSegments(
  items: readonly StreamTabDisplayItem[],
  width?: number,
): readonly StreamTabLineSegment[] {
  const segments = buildLineSegments(items, width);
  const activeIndex = items.findIndex((item) => item.active);
  const activeItem = activeIndex === -1 ? undefined : items[activeIndex];
  if (
    width === undefined ||
    !activeItem ||
    segments.some((segment) => segment.item === activeItem)
  ) {
    return segments;
  }

  const activeSegments = buildLineSegments(
    activeAnchoredItems(items, activeIndex),
    width,
  );
  if (activeSegments.some((segment) => segment.item === activeItem)) {
    return activeSegments;
  }
  return buildLineSegments([activeItem], width);
}

function streamTabsTextLength(items: readonly StreamTabDisplayItem[]): number {
  return textDisplayWidth(streamTabsLineText(items));
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
  } else if (activeIndex <= 0) {
    keep.add(1);
  }

  const out: StreamTabDisplayItem[] = [];
  let elided = false;
  for (const [i, item] of items.entries()) {
    if (keep.has(i)) {
      if (elided) {
        out.push(ELLIPSIS_TAB_ITEM);
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
  readonly childStreamEntries: ChildStreamEntries;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly width: number;
}): readonly StreamTabDisplayItem[] {
  const views = activeStreamTreeViews(init);
  const items = views.map((view): StreamTabDisplayItem => {
    const slice = view.slice;
    const status = formatStreamStatusLabel(slice?.status, {
      style: 'cliCompact',
      // A tab with a parent is a child/subagent stream; the root tab has no
      // parentId. WAITING reads differently for each (see
      // CLI_CHILD_WAITING_LABEL), so the two must not share one label here.
      isChildStream: view.parentId !== undefined,
      ...(slice?.substate ? { substate: slice.substate } : {}),
    });
    return {
      id: view.id,
      label: truncateToWidth(view.label, MAX_LABEL_WIDTH),
      active: view.active,
      running: isActivePhase(slice?.status),
      shortcutIndex: view.shortcutIndex,
      status,
      ended: isTerminalOutcomePhase(slice?.status),
    };
  });
  return collapseMiddle(items, init.width);
}

function StreamTabsStripView(props: {
  readonly items: readonly StreamTabDisplayItem[];
  readonly width: number;
}): React.JSX.Element | null {
  if (props.items.length === 0) return null;
  const segments = streamTabsLineSegments(
    props.items,
    Math.max(0, props.width - 2),
  );

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

function StreamTabsStripFromState(props: {
  readonly width: number;
}): React.JSX.Element | null {
  const activeStreamId = useSignal(activeStreamIdSignal);
  const streams = useSignal(streamsSignal);
  const parentStream = useSignal(parentStreamSignal);
  const childStreamEntries = useSignal(childStreamEntriesSignal);
  const items = streamTabsDisplayItems({
    activeStreamId,
    childStreamEntries,
    streams,
    parentStream,
    width: props.width,
  });
  return <StreamTabsStripView items={items} width={props.width} />;
}

export function StreamTabsStrip(props: {
  readonly items?: readonly StreamTabDisplayItem[];
  readonly width: number;
}): React.JSX.Element | null {
  if (props.items !== undefined) {
    return <StreamTabsStripView items={props.items} width={props.width} />;
  }
  return <StreamTabsStripFromState width={props.width} />;
}
