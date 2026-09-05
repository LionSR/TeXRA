import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMemo } from 'react';

import { Select, type SelectItem } from '@cli/tui/ui/Select';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { POINTER, TICK } from '@cli/tui/ui/glyphs';
import { useLiveNowMsSince } from '@cli/tui/useLiveNowMs';
import { truncateSummaryToWidth } from '@cli/runtime/terminalText';
import { type StreamTabId } from '@shared/schemas';
import type { StreamView } from '@shared/session/sessionView';
import { formatStageLabel } from '@shared/streams/streamStatusDisplay';
import { formatResultCount } from '@utils/text/stringUtils';

import { childElapsed } from '../state/childControls';
import {
  cumulativeUsageOf,
  sessionView,
  streamLabelOf,
  streamPhaseOf,
  streamViewOf,
} from '../state/sessionView';
import {
  CHILD_ROW_METADATA_MIN_COLUMNS,
  CHILD_STATUS_MARKER,
  childRowMetadataText,
  childStatusColor,
  pendingApprovalRowDisplay,
} from './SubagentListDisplay';
import { useSignal } from '../state/useSignal';
import type { PendingApprovalKind } from '../state/approvalQueue';

const SUBAGENT_SUMMARY_MAX_COLUMNS = 100;

interface SegmentStyle {
  readonly bold?: boolean;
  readonly color?: string;
}

export function RowSegment({
  bold,
  children,
  color,
  dimColor,
  flexShrink,
}: SegmentStyle & {
  readonly children: React.ReactNode;
  readonly dimColor?: boolean;
  readonly flexShrink: number;
}): React.JSX.Element {
  return (
    <Box minWidth={0} flexShrink={flexShrink}>
      <Text bold={bold} color={color} dimColor={dimColor} wrap="truncate-end">
        {children}
      </Text>
    </Box>
  );
}

export function ApprovalSegments({
  approval,
  bold,
  color,
}: SegmentStyle & {
  readonly approval: ReturnType<typeof pendingApprovalRowDisplay>;
}): React.JSX.Element | null {
  if (!approval) return null;
  return (
    <>
      <Box flexShrink={0}>
        <Text bold={bold} color={color}>{` · ${approval.label}`}</Text>
      </Box>
      {approval.overflow ? (
        <RowSegment bold={bold} color={color} flexShrink={3}>
          {` ${approval.overflow}`}
        </RowSegment>
      ) : null}
    </>
  );
}

function SessionRow({
  active,
  focused,
  hiddenRowSummary,
  isListRoot,
  metadataColumn,
  nowMs,
  pendingKinds,
  stream,
}: {
  readonly active: boolean;
  readonly focused: boolean;
  readonly hiddenRowSummary: string | undefined;
  readonly isListRoot: boolean;
  readonly metadataColumn: boolean;
  readonly nowMs: number;
  readonly pendingKinds: readonly PendingApprovalKind[] | undefined;
  readonly stream: StreamView;
}): React.JSX.Element {
  const status = streamPhaseOf(stream);
  const statusLabel = stream.statusLabel;
  const elapsed = childElapsed(
    { status, startedAt: stream.runStartedAt ?? undefined },
    nowMs,
  );
  const approval = pendingApprovalRowDisplay(pendingKinds);
  const stageLabel = formatStageLabel(stream.stage ?? undefined);
  const modelLabel = isListRoot ? undefined : stream.modelLabel;
  const metadataText = metadataColumn
    ? childRowMetadataText({
        elapsed,
        outputTokens: cumulativeUsageOf(stream)?.outputTokens,
        toolCallCount: stream.conversationProgress.toolCallCount,
      })
    : undefined;
  const summary = isListRoot
    ? undefined
    : (stream.description ?? stream.latestLine ?? undefined);
  return (
    <Box
      flexDirection="row"
      flexGrow={1}
      height={1}
      minWidth={0}
      overflowY="hidden"
    >
      <Text aria-hidden color={focused ? COLOR_HINT : undefined}>
        {focused ? POINTER : ' '}
      </Text>
      <Text aria-hidden color={active ? COLOR_HINT : undefined}>
        {active ? ` ${TICK} ` : '   '}
      </Text>
      <Text aria-hidden color={childStatusColor(status)}>
        {CHILD_STATUS_MARKER}
      </Text>
      <RowSegment bold={active} flexShrink={1}>
        {streamLabelOf(stream)}
        {statusLabel ? ` ${statusLabel}` : ''}
        {stageLabel ? ` · ${stageLabel}` : ''}
        {modelLabel ? ` · ${modelLabel}` : ''}
        {!metadataColumn && elapsed ? ` · ${elapsed}` : ''}
      </RowSegment>
      {summary ? (
        <RowSegment dimColor flexShrink={2}>
          {` · ${truncateSummaryToWidth(summary, SUBAGENT_SUMMARY_MAX_COLUMNS)}`}
        </RowSegment>
      ) : null}
      <ApprovalSegments approval={approval} />
      {focused && hiddenRowSummary ? (
        <RowSegment dimColor flexShrink={4}>
          {` · ${hiddenRowSummary}`}
        </RowSegment>
      ) : null}
      {metadataText ? (
        <>
          <Box flexGrow={1} />
          <Box flexShrink={0}>
            <Text dimColor>{`  ${metadataText}`}</Text>
          </Box>
        </>
      ) : null}
    </Box>
  );
}

export interface SubagentListProps {
  readonly activeStreamId?: StreamTabId;
  readonly keyboardActive?: boolean;
  readonly maxRows?: number;
  readonly onCancel?: () => void;
  readonly onFocusStream?: (streamId: StreamTabId) => void;
  readonly onKillExecution?: (executionId: string) => void;
  readonly onSelectionChange?: (value: StreamTabId) => void;
  readonly pendingApprovals?: ReadonlyMap<
    string,
    readonly PendingApprovalKind[]
  >;
  readonly selectedValue?: StreamTabId;
  /** The focus tree: the list root first, then its children. */
  readonly sessions?: readonly StreamTabId[];
  readonly listRootStreamId?: StreamTabId;
  readonly activeSubagentExecutionIds?: ReadonlyMap<StreamTabId, string>;
}

export function SubagentList(
  props: SubagentListProps = {},
): React.JSX.Element | null {
  const view = useSignal(sessionView());
  const sessions = props.sessions ?? [];
  const streams = useMemo(
    () =>
      sessions.flatMap((streamId) => {
        const stream = streamViewOf(view, streamId);
        return stream ? [stream] : [];
      }),
    [sessions, view],
  );
  const startedAts = useMemo(
    () => streams.map((stream) => stream.runStartedAt ?? undefined),
    [streams],
  );
  const { items, streamsByValue } = useMemo(() => {
    const nextItems: SelectItem<StreamTabId>[] = [];
    const byValue = new Map<StreamTabId, StreamView>();
    for (const stream of streams) {
      nextItems.push({ label: streamLabelOf(stream), value: stream.id });
      byValue.set(stream.id, stream);
    }
    return { items: nextItems, streamsByValue: byValue };
  }, [streams]);
  const nowMs = useLiveNowMsSince(startedAts);
  const { columns } = useWindowSize();
  const metadataColumn = columns >= CHILD_ROW_METADATA_MIN_COLUMNS;
  const contentRows =
    props.maxRows === undefined ? undefined : Math.max(0, props.maxRows - 1);
  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return;
      const streamId = props.selectedValue;
      if (!streamId) return;
      if (input.toLowerCase() !== 'k') return;
      const executionId = props.activeSubagentExecutionIds?.get(streamId);
      if (executionId) props.onKillExecution?.(executionId);
    },
    { isActive: props.keyboardActive ?? false },
  );
  if (items.length === 0) return null;
  if (contentRows !== undefined && contentRows <= 0) return null;
  return (
    <Box
      flexDirection="column"
      height={contentRows}
      marginTop={1}
      overflowY={contentRows === undefined ? undefined : 'hidden'}
      paddingX={1}
      width={metadataColumn ? columns : undefined}
    >
      <Select
        activeValue={props.activeStreamId}
        highlightedValue={props.selectedValue ?? null}
        hotkeys={false}
        isActive={props.keyboardActive}
        items={items}
        maxVisibleItems={contentRows}
        onCancel={props.onCancel ?? (() => undefined)}
        wrap={false}
        onHighlightChange={(value) => props.onSelectionChange?.(value)}
        onSelect={(value) => {
          if (value) props.onFocusStream?.(value);
        }}
        renderItem={(item, state) => {
          const stream = streamsByValue.get(item.value);
          return stream ? (
            <SessionRow
              isListRoot={stream.id === props.listRootStreamId}
              active={state.active}
              focused={state.focused}
              hiddenRowSummary={
                state.hiddenItemCount > 0
                  ? `+${formatResultCount(state.hiddenItemCount, 'agent')}`
                  : undefined
              }
              metadataColumn={metadataColumn}
              nowMs={nowMs}
              pendingKinds={props.pendingApprovals?.get(stream.id)}
              stream={stream}
            />
          ) : null;
        }}
      />
    </Box>
  );
}
