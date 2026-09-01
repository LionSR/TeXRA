// Persistent child-session list.

// Third-party imports
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMemo } from 'react';

// Local imports - shared stream state
import { Select, type SelectItem } from '@cli/tui/ui/Select';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { POINTER, TICK } from '@cli/tui/ui/glyphs';
import { useLiveNowMsSince } from '@cli/tui/useLiveNowMs';
import { truncateSummaryToWidth } from '@cli/runtime/terminalText';
import { type StreamTabId, type TokenUsageStats } from '@shared/schemas';
import { formatStageLabel } from '@shared/streams/streamStatusDisplay';
import { formatResultCount } from '@utils/text/stringUtils';

// Local imports - TUI rendering
import { formatCliStatusLabel } from '../sessionStatus';

// Local imports - TUI state and controls
import { childElapsed } from '../state/childControls';
import {
  sessionStateRevision,
  streamMetadataFor,
  streamStateFor,
} from '../state/childExecutions';
import {
  readStreamArtifacts,
  streamArtifactRevision,
} from '../state/subscribeStreamArtifacts';

import {
  CHILD_ROW_METADATA_MIN_COLUMNS,
  CHILD_STATUS_MARKER,
  childRowMetadataText,
  childStatusColor,
  pendingApprovalRowDisplay,
} from './SubagentListDisplay';
import { useSignal } from '../state/useSignal';
import { streamPhaseFor } from '../state/cliState';
import type { PendingApprovalKind } from '../state/approvalQueue';
import type { StreamView } from '../state/streamViews';

const SUBAGENT_SUMMARY_MAX_COLUMNS = 100;

/** Emphasis a row segment inherits from its host row. */
interface SegmentStyle {
  readonly bold?: boolean;
  readonly color?: string;
}

/** One inline segment of a single-line row: a cell that may shrink to nothing
 *  and truncates rather than wrapping. `flexShrink` carries the significance
 *  order — higher numbers yield first as the row narrows. */
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

/** The ` · <kind>` pending-approval suffix shared by session rows and the
 *  workflow popup's task rows. The kind is actionable so it never shrinks; the
 *  overflow count is informational and yields early. */
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
  cumulativeUsage,
  focused,
  hiddenRowSummary,
  isListRoot,
  metadataColumn,
  nowMs,
  pendingKinds,
  session,
}: {
  readonly active: boolean;
  readonly cumulativeUsage?: TokenUsageStats;
  readonly focused: boolean;
  readonly hiddenRowSummary: string | undefined;
  readonly isListRoot: boolean;
  readonly metadataColumn: boolean;
  readonly nowMs: number;
  readonly pendingKinds: readonly PendingApprovalKind[] | undefined;
  readonly session: StreamView;
}): React.JSX.Element {
  useSignal(sessionStateRevision);
  const metadata = streamMetadataFor(session.id);
  const streamState = streamStateFor(session.id);
  const phase = streamPhaseFor(session.id);
  const status = phase?.phase;
  const statusLabel = formatCliStatusLabel(
    status,
    phase?.substate,
    session.parentId !== undefined,
  );
  const elapsed = childElapsed(
    { status, startedAt: phase?.runStartedAt },
    nowMs,
  );
  // Significance order — informational counts shed first, then the summary,
  // then this truncate-end text sheds inline elapsed, model, stage, and label.
  // The actionable approval kind and metadata column never shrink.
  const approval = pendingApprovalRowDisplay(pendingKinds);
  const stageLabel = formatStageLabel(streamState?.stage);
  // The resolved model is per-agent identity (a workflow run's grandchildren
  // can each resolve a different model); the list-root row is the conversation
  // itself, whose model already rides the status bar. `buildStreamTabInfo`
  // already leaves `modelLabel` unset for a process stream (a shell uses no
  // model) and for a config whose model has not resolved.
  const modelLabel = isListRoot ? undefined : session.info?.modelLabel;
  // The right-aligned `elapsed · ↓tokens` column is pushed to the terminal edge
  // so the figures line up across rows. Lower-priority inline segments yield;
  // rows drop the column entirely on narrow terminals (see
  // `CHILD_ROW_METADATA_MIN_COLUMNS`).
  const metadataText = metadataColumn
    ? childRowMetadataText({
        elapsed,
        outputTokens: cumulativeUsage?.outputTokens,
        toolCallCount: streamState?.conversationProgress.toolCallCount,
      })
    : undefined;
  // Child rows summarize what the subagent is doing: the runtime's own
  // description (delegated task, or the generated session one-liner) when it
  // has one, otherwise the latest transcript line as live status. The
  // list-root row is the conversation itself — echoing its own last exchange
  // there is noise (and the root can itself be a nested subagent when focus
  // is scoped).
  const summary = isListRoot
    ? undefined
    : (metadata?.description ?? session.slice?.latestLine);
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
        {session.label}
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
  readonly keyboardActive?: boolean;
  readonly maxRows?: number;
  readonly onCancel?: () => void;
  readonly onFocusStream?: (streamId: StreamTabId) => void;
  readonly onKillExecution?: (executionId: string) => void;
  readonly onSelectionChange?: (value: StreamTabId) => void;
  /**
   * Pending approval kinds per stream id (see `pendingApprovalSummaries`; the
   * caller folds stream-less approvals onto the visible surface root via
   * `groupPendingApprovalsByRow`).
   *
   * Stream-bound plan, proposal, and retry approvals remain keyed to their
   * actual owning stream. The queue remains the authority for approval
   * identity and order; this map only projects that state onto the rows which
   * present it.
   */
  readonly pendingApprovals?: ReadonlyMap<
    string,
    readonly PendingApprovalKind[]
  >;
  readonly selectedValue?: StreamTabId;
  readonly sessions?: readonly StreamView[];
  /** Stream the list is rooted on — its row never shows a summary. */
  readonly listRootStreamId?: StreamTabId;
  readonly activeSubagentExecutionIds?: ReadonlyMap<StreamTabId, string>;
}

export function SubagentList(
  props: SubagentListProps = {},
): React.JSX.Element | null {
  const sessions = props.sessions ?? [];
  useSignal(streamArtifactRevision);
  const startedAts = useMemo(
    () => sessions.map((session) => streamPhaseFor(session.id)?.runStartedAt),
    [sessions],
  );
  const { items, sessionsByValue } = useMemo(() => {
    const nextItems: SelectItem<StreamTabId>[] = [];
    const byValue = new Map<StreamTabId, StreamView>();
    // Row order has one owner, `streamTreeEntries`: do not re-sort here, it
    // would desynchronise the Alt+1..9 numbers it assigns from the rows on
    // screen.
    for (const session of sessions) {
      nextItems.push({ label: session.label, value: session.id });
      byValue.set(session.id, session);
    }
    return { items: nextItems, sessionsByValue: byValue };
  }, [sessions]);
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
  // The list is deliberately separated from the input/status chrome by one
  // blank row. If the gap and one content row do not both fit, render nothing.
  if (contentRows !== undefined && contentRows <= 0) return null;
  const activeSession = sessions.find((session) => session.active);

  return (
    <Box
      flexDirection="column"
      height={contentRows}
      marginTop={1}
      overflowY={contentRows === undefined ? undefined : 'hidden'}
      paddingX={1}
      // Pin the panel to the terminal width so rows stretch and the trailing
      // metadata column right-aligns; without it the panel is content-sized.
      width={metadataColumn ? columns : undefined}
    >
      <Select
        activeValue={activeSession?.id}
        highlightedValue={props.selectedValue ?? null}
        hotkeys={false}
        isActive={props.keyboardActive}
        items={items}
        maxVisibleItems={contentRows}
        onCancel={props.onCancel ?? (() => undefined)}
        // This panel is a standalone focus target, not a cyclic menu: arrows
        // clamp at the first/last selectable stream row. Tab explicitly hands
        // keyboard ownership back to the input at the App level.
        wrap={false}
        onHighlightChange={(value) => props.onSelectionChange?.(value)}
        onSelect={(value) => {
          if (value) props.onFocusStream?.(value);
        }}
        renderItem={(item, state) => {
          const session = sessionsByValue.get(item.value);
          return session ? (
            <SessionRow
              isListRoot={session.id === props.listRootStreamId}
              active={state.active}
              cumulativeUsage={readStreamArtifacts(session.id)?.cumulativeUsage}
              focused={state.focused}
              hiddenRowSummary={
                state.hiddenItemCount > 0
                  ? `+${formatResultCount(state.hiddenItemCount, 'agent')}`
                  : undefined
              }
              metadataColumn={metadataColumn}
              nowMs={nowMs}
              pendingKinds={props.pendingApprovals?.get(session.id)}
              session={session}
            />
          ) : null;
        }}
      />
    </Box>
  );
}
