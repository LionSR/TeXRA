import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMemo } from 'react';

import { Select, type SelectItem } from '@cli/tui/ui/Select';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { POINTER, TICK } from '@cli/tui/ui/glyphs';
import { useLiveNowMsSince } from '@cli/tui/useLiveNowMs';
import { truncateSummaryToWidth } from '@cli/runtime/terminalText';
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import type { StreamView } from '@shared/session/sessionView';
import { formatStageLabel } from '@shared/streams/streamStatusDisplay';
import { formatResultCount } from '@utils/text/stringUtils';

import { childElapsed } from '../state/childControls';
import {
  cumulativeUsageOf,
  killableExecutionId,
  streamPhaseOf,
} from '../state/sessionView';
import {
  CHILD_ROW_METADATA_MIN_COLUMNS,
  CHILD_STATUS_MARKER,
  childRowMetadataText,
  CHILD_TONE_COLOR,
  pendingApprovalRowDisplay,
} from './SubagentListDisplay';
import { expandedStreams, type SessionListRow } from '../state/cliState';
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
  depth,
  expanded,
  metadataColumn,
  nowMs,
  pendingKinds,
  stream,
}: {
  readonly active: boolean;
  readonly focused: boolean;
  readonly hiddenRowSummary: string | undefined;
  readonly depth: number;
  readonly expanded: boolean;
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
  const modelLabel = stream.parentId === null ? undefined : stream.modelLabel;
  const metadataText = metadataColumn
    ? childRowMetadataText({
        elapsed,
        outputTokens: cumulativeUsageOf(stream)?.outputTokens,
        toolCallCount: stream.conversationProgress.toolCallCount,
      })
    : undefined;
  const summary = stream.description;
  const color = CHILD_TONE_COLOR[stream.tone];
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
      <Text aria-hidden color={color}>
        {'  '.repeat(depth)}
        {stream.category !== AgentCategory.Workflow &&
        stream.childIds.length > 0
          ? `${expanded ? '▾' : '▸'} `
          : '  '}
        {CHILD_STATUS_MARKER}
      </Text>
      <RowSegment bold={active} color={color} flexShrink={1}>
        {stream.label}
        {statusLabel ? ` ${statusLabel}` : ''}
        {stageLabel ? ` · ${stageLabel}` : ''}
        {modelLabel ? ` · ${modelLabel}` : ''}
        {!metadataColumn && elapsed ? ` · ${elapsed}` : ''}
      </RowSegment>
      {!expanded && stream.rollup.total > 0 ? (
        <RowSegment color={color} flexShrink={metadataColumn ? 0 : 1}>
          {` [${stream.rollup.total} total · ${stream.rollup.running} running · ${stream.rollup.finished} finished]`}
        </RowSegment>
      ) : null}
      {stream.group === 'interrupted' && stream.resumeEligible ? (
        <RowSegment color={color} flexShrink={0}>
          {' '}
          · Resume
        </RowSegment>
      ) : null}
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
  readonly rows: readonly SessionListRow[];
}

export function SubagentList(
  props: SubagentListProps,
): React.JSX.Element | null {
  const rows = props.rows;
  const items = useMemo<SelectItem<SessionListRow>[]>(
    () =>
      rows.map((row) => ({
        value: row,
        label: row.kind === 'group' ? row.label : row.stream.label,
        disabled: row.kind === 'group',
      })),
    [rows],
  );
  const startedAts = useMemo(
    () =>
      rows.flatMap((row) =>
        row.kind === 'stream' ? [row.stream.runStartedAt ?? undefined] : [],
      ),
    [rows],
  );
  const selectedRow = rows.find(
    (row) => row.kind === 'stream' && row.stream.id === props.selectedValue,
  );
  const nowMs = useLiveNowMsSince(startedAts);
  const { columns } = useWindowSize();
  const metadataColumn = columns >= CHILD_ROW_METADATA_MIN_COLUMNS;
  const contentRows =
    props.maxRows === undefined ? undefined : Math.max(0, props.maxRows - 1);
  useInput(
    (input, key) => {
      if (key.ctrl || key.meta || selectedRow?.kind !== 'stream') return;
      const { stream, expanded } = selectedRow;
      if (key.leftArrow || key.rightArrow || input === ' ') {
        const next = key.rightArrow || (!key.leftArrow && !expanded);
        expandedStreams.set(
          new Map(expandedStreams.get()).set(stream.id, next),
        );
      } else if (
        input.toLowerCase() === 'r' &&
        stream.group === 'interrupted' &&
        stream.resumeEligible
      ) {
        props.onFocusStream?.(stream.id);
      } else if (input.toLowerCase() === 'k') {
        const executionId = killableExecutionId(stream);
        if (executionId) props.onKillExecution?.(executionId);
      }
    },
    { isActive: props.keyboardActive ?? false },
  );
  if (items.length === 0 || (contentRows !== undefined && contentRows <= 0))
    return null;
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
        activeValue={rows.find(
          (row) =>
            row.kind === 'stream' && row.stream.id === props.activeStreamId,
        )}
        highlightedValue={selectedRow ?? null}
        hotkeys={false}
        isActive={props.keyboardActive}
        items={items}
        maxVisibleItems={contentRows}
        onCancel={props.onCancel ?? (() => undefined)}
        wrap={false}
        onHighlightChange={(row) => {
          if (row.kind === 'stream') props.onSelectionChange?.(row.stream.id);
        }}
        onSelect={(row) => {
          if (row.kind === 'stream') props.onFocusStream?.(row.stream.id);
        }}
        renderItem={({ value: row }, state) =>
          row.kind === 'group' ? (
            <Text bold dimColor>
              {row.label}
            </Text>
          ) : (
            <SessionRow
              depth={row.depth}
              expanded={row.expanded}
              active={state.active}
              focused={state.focused}
              hiddenRowSummary={
                state.hiddenItemCount > 0
                  ? `+${formatResultCount(state.hiddenItemCount, 'row')}`
                  : undefined
              }
              metadataColumn={metadataColumn}
              nowMs={nowMs}
              pendingKinds={props.pendingApprovals?.get(row.stream.id)}
              stream={row.stream}
            />
          )
        }
      />
    </Box>
  );
}
