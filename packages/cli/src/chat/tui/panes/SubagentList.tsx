// Persistent child-session list.

// Third-party imports
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMemo } from 'react';

// Local imports - shared stream state
import type { StreamTabId } from '@shared/schemas';
import {
  formatPhaseStageLabel,
  formatRoundStageLabel,
  formatStreamStatusLabel,
} from '@shared/streams/streamStatusDisplay';
import { formatResultCount } from '@utils/text/stringUtils';

// Local imports - TUI rendering
import { truncateSummaryToWidth } from '../render/terminalText';

// Local imports - TUI state and controls
import { childElapsed } from '../state/childControls';
import {
  childListStreamId,
  childPhaseListValue,
  childStreamListValue,
  type ChildListValue,
} from '../state/childListSelection';
import {
  childPhaseGroupRows,
  type ChildPhaseGroupRow,
  type ChildPhaseHeader,
} from '../state/childPhaseGroups';
import { useLiveNowMs } from '../state/useLiveNowMs';
import { COLOR_HINT } from '../ui/colors';
import { POINTER, TICK } from '../ui/glyphs';
import { Select, visibleSelectRange } from '../ui/Select';
import {
  CHILD_ROW_METADATA_MIN_COLUMNS,
  CHILD_STATUS_MARKER,
  childRowMetadataText,
  childStatusColor,
  pendingApprovalRowSuffix,
} from './SubagentListDisplay';
import type { PendingApprovalKind } from '../state/approvalQueue';
import type { StreamView } from '../state/streamViews';

function HiddenRowSummary({
  text,
}: {
  readonly text: string | undefined;
}): React.JSX.Element | null {
  return text ? (
    <Box flexShrink={0}>
      <Text dimColor>{` · ${text}`}</Text>
    </Box>
  ) : null;
}

/** Right-aligned `elapsed · ↓tokens` column, pushed to the terminal edge so
 *  the figures line up across rows. Non-shrinking: the summary segment yields
 *  first; rows drop the column entirely on narrow terminals (see
 *  `CHILD_ROW_METADATA_MIN_COLUMNS`). */
function RowMetadata({
  text,
}: {
  readonly text: string | undefined;
}): React.JSX.Element | null {
  return text ? (
    <>
      <Box flexGrow={1} />
      <Box flexShrink={0}>
        <Text dimColor>{`  ${text}`}</Text>
      </Box>
    </>
  ) : null;
}

const SUBAGENT_SUMMARY_MAX_COLUMNS = 100;

/** Indent that lands the `◆` on the same column as a row's status marker
 *  (`SessionRow` prints a 1-column pointer slot then a 3-column tick slot). */
const PHASE_HEADER_INDENT = '    ';

/** Non-selectable divider above one phase's rows. `done/total` right-aligns
 *  into the metadata column when the panel is pinned to the terminal width,
 *  and falls back inline below `CHILD_ROW_METADATA_MIN_COLUMNS` — the same
 *  width gate the rows use to shed their own metadata column. */
function PhaseHeaderRow({
  header,
  metadataColumn,
}: {
  readonly header: ChildPhaseHeader;
  readonly metadataColumn: boolean;
}): React.JSX.Element {
  const progress = header.progress;
  return (
    <Box
      flexDirection="row"
      flexGrow={1}
      height={1}
      minWidth={0}
      overflowY="hidden"
    >
      <Box minWidth={0} flexShrink={1}>
        <Text dimColor wrap="truncate-end">
          {`${PHASE_HEADER_INDENT}${header.label}`}
          {!metadataColumn && progress ? ` · ${progress}` : ''}
        </Text>
      </Box>
      {metadataColumn ? <RowMetadata text={progress} /> : null}
    </Box>
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
  session,
}: {
  readonly active: boolean;
  readonly focused: boolean;
  readonly hiddenRowSummary: string | undefined;
  readonly isListRoot: boolean;
  readonly metadataColumn: boolean;
  readonly nowMs: number;
  readonly pendingKinds: readonly PendingApprovalKind[] | undefined;
  readonly session: StreamView;
}): React.JSX.Element {
  const status = session.slice?.status;
  const statusLabel = formatStreamStatusLabel(status, {
    style: 'cli',
    isChildStream: session.parentId !== undefined,
    ...(session.slice?.substate ? { substate: session.slice.substate } : {}),
  });
  const elapsed = childElapsed(
    {
      status,
      startedAt: session.slice?.runStartedAt,
    },
    nowMs,
  );
  // Significance order — the summary segment sheds first (flexShrink 2), then
  // this truncate-end text sheds inline elapsed (narrow mode only), the round,
  // and last the pending-approval kind. The metadata column never shrinks.
  const approvalSuffix = pendingApprovalRowSuffix(pendingKinds);
  // A workflow-script run advances through phases, a tool-use run through
  // rounds; one slot carries whichever this stream has.
  const stageLabel =
    formatPhaseStageLabel(session.slice?.phaseStage) ??
    formatRoundStageLabel(session.slice?.roundStage);
  // The resolved model is per-agent identity (a workflow run's grandchildren
  // can each resolve a different model); the list-root row is the conversation
  // itself, whose model already rides the status bar. A background bash stream
  // inherits its parent's configuration, but the shell does not use a model.
  const modelLabel =
    !isListRoot && session.toolName !== 'bash'
      ? session.slice?.model
      : undefined;
  const metadata = metadataColumn
    ? childRowMetadataText({
        elapsed,
        outputTokens: (session.slice?.cumulativeUsage ?? session.slice?.usage)
          ?.outputTokens,
        toolCallCount: session.slice?.conversation?.toolCallCount,
      })
    : undefined;
  // Child rows summarize what the subagent last said; the list-root row is
  // the conversation itself — echoing its own last exchange there is noise
  // (and the root can itself be a nested subagent when focus is scoped).
  const summary = isListRoot ? undefined : session.slice?.description;
  return (
    <Box
      flexDirection="row"
      flexGrow={1}
      height={1}
      minWidth={0}
      overflowY="hidden"
    >
      <Text color={focused ? COLOR_HINT : undefined}>
        {focused ? POINTER : ' '}
      </Text>
      <Text color={active ? COLOR_HINT : undefined}>
        {active ? ` ${TICK} ` : '   '}
      </Text>
      <Text color={childStatusColor(status)}>{CHILD_STATUS_MARKER}</Text>
      <Box minWidth={0} flexShrink={1}>
        <Text bold={active} wrap="truncate-end">
          {session.label}
          {statusLabel ? ` ${statusLabel}` : ''}
          {approvalSuffix ? ` · ${approvalSuffix}` : ''}
          {stageLabel ? ` · ${stageLabel}` : ''}
          {modelLabel ? ` · ${modelLabel}` : ''}
          {!metadataColumn && elapsed ? ` · ${elapsed}` : ''}
        </Text>
      </Box>
      {summary ? (
        <Box minWidth={0} flexShrink={2}>
          <Text dimColor wrap="truncate-end">
            {` · ${truncateSummaryToWidth(summary, SUBAGENT_SUMMARY_MAX_COLUMNS)}`}
          </Text>
        </Box>
      ) : null}
      {focused ? <HiddenRowSummary text={hiddenRowSummary} /> : null}
      <RowMetadata text={metadata} />
    </Box>
  );
}

function childListRowValue(
  row: ChildPhaseGroupRow<StreamView>,
): ChildListValue {
  return row.kind === 'header'
    ? childPhaseListValue(row.header.phase)
    : childStreamListValue(row.row.id);
}

export interface SubagentListProps {
  readonly keyboardActive?: boolean;
  readonly maxRows?: number;
  readonly onCancel?: () => void;
  readonly onFocusStream?: (streamId: StreamTabId) => void;
  readonly onKillExecution?: (executionId: string) => void;
  /** Skip the focused, in-flight workflow-script grandchild `agent()` call. */
  readonly onSkipExecution?: (executionId: string) => void;
  /** Retry the focused, in-flight workflow-script grandchild `agent()` call. */
  readonly onRetryExecution?: (executionId: string) => void;
  readonly onSelectionChange?: (value: ChildListValue) => void;
  readonly onPrintStream?: (streamId: StreamTabId) => void;
  /** Pending approval kinds per stream id (see `pendingApprovalSummaries`,
   *  root bucket already folded onto the root stream id by the caller). */
  readonly pendingApprovals?: ReadonlyMap<
    string,
    readonly PendingApprovalKind[]
  >;
  readonly selectedValue?: ChildListValue;
  readonly sessions?: readonly StreamView[];
  /** Stream the list is rooted on — its row never shows a summary. */
  readonly listRootStreamId?: StreamTabId;
  readonly activeSubagentExecutionIds?: ReadonlyMap<StreamTabId, string>;
}

export function SubagentList(
  props: SubagentListProps = {},
): React.JSX.Element | null {
  const sessions = props.sessions ?? [];
  const liveElapsedKey = useMemo(
    () =>
      sessions
        .map((session) => session.slice?.runStartedAt)
        .filter((startedAt): startedAt is number => startedAt !== undefined)
        .join(':') || undefined,
    [sessions],
  );
  // The run's own transcript owns the phase outline and the task cards; it is
  // the active stream whenever this list is rooted on it, so its entries are
  // fully projected. `streamTreeEntries` already grouped these rows with the
  // same rule, so this pass only inserts the dividers.
  const listRootEntries = useMemo(
    () =>
      sessions.find((session) => session.id === props.listRootStreamId)?.slice
        ?.entries,
    [props.listRootStreamId, sessions],
  );
  const rows = useMemo(
    () =>
      childPhaseGroupRows({
        rows: sessions,
        phases: (listRootEntries ?? []).flatMap((entry) =>
          entry.role === 'phase' ? [entry] : [],
        ),
        tasks: (listRootEntries ?? []).flatMap((entry) =>
          entry.role === 'workflowTask' ? [entry.task] : [],
        ),
      }),
    [listRootEntries, sessions],
  );
  const items = useMemo(
    () =>
      rows.map((row) =>
        row.kind === 'header'
          ? {
              label: row.header.label,
              value: childListRowValue(row),
              disabled: true,
            }
          : { label: row.row.label, value: childListRowValue(row) },
      ),
    [rows],
  );
  const rowsByValue = useMemo(
    () => new Map(rows.map((row) => [childListRowValue(row), row])),
    [rows],
  );
  const nowMs = useLiveNowMs(liveElapsedKey !== undefined, liveElapsedKey);
  const { columns } = useWindowSize();
  const metadataColumn = columns >= CHILD_ROW_METADATA_MIN_COLUMNS;
  const contentRows =
    props.maxRows === undefined ? undefined : Math.max(0, props.maxRows - 1);
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.value === props.selectedValue),
  );
  const visibleRange = visibleSelectRange({
    highlight: selectedIndex,
    itemCount: items.length,
    maxVisibleItems: contentRows,
  });
  const visibleValues = new Set(
    items.slice(visibleRange.start, visibleRange.end).map((item) => item.value),
  );
  const hiddenSessionCount = sessions.filter(
    (session) => !visibleValues.has(childStreamListValue(session.id)),
  ).length;
  const hiddenRowSummary =
    hiddenSessionCount > 0
      ? `+${formatResultCount(hiddenSessionCount, 'session')}`
      : undefined;

  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return;
      const streamId = childListStreamId(props.selectedValue);
      const pressed = input.toLowerCase();
      if (pressed === 'v' && streamId) {
        props.onPrintStream?.(streamId);
        return;
      }
      // Skip/retry target only a focused subagent stream (a workflow-script
      // grandchild); the session control registry no-ops for any execution id
      // that is not an in-flight grandchild, so non-workflow rows are inert.
      if ((pressed === 's' || pressed === 'r') && streamId) {
        const executionId = props.activeSubagentExecutionIds?.get(streamId);
        if (!executionId) return;
        if (pressed === 's') props.onSkipExecution?.(executionId);
        else props.onRetryExecution?.(executionId);
        return;
      }
      if (pressed !== 'k') return;
      const executionId = streamId
        ? props.activeSubagentExecutionIds?.get(streamId)
        : undefined;
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
        activeValue={
          activeSession ? childStreamListValue(activeSession.id) : undefined
        }
        highlightedValue={props.selectedValue ?? null}
        hotkeys={false}
        isActive={props.keyboardActive}
        items={items}
        maxVisibleItems={contentRows}
        onCancel={props.onCancel ?? (() => undefined)}
        // This panel is a standalone focus target, not a cyclic menu: Down
        // past the last row hands keyboard ownership back to the input
        // (mirrors Tab) instead of wrapping to the top.
        wrap={false}
        onBoundaryEscape={(direction) => {
          if (direction === 1) props.onCancel?.();
        }}
        onHighlightChange={(value) => props.onSelectionChange?.(value)}
        onSelect={(value) => {
          const streamId = childListStreamId(value);
          if (streamId) props.onFocusStream?.(streamId);
        }}
        renderItem={(item, state) => {
          const row = rowsByValue.get(item.value);
          if (!row) return null;
          if (row.kind === 'header') {
            return (
              <PhaseHeaderRow
                header={row.header}
                metadataColumn={metadataColumn}
              />
            );
          }
          const session = row.row;
          return (
            <SessionRow
              isListRoot={session.id === props.listRootStreamId}
              active={state.active}
              focused={state.focused}
              hiddenRowSummary={hiddenRowSummary}
              metadataColumn={metadataColumn}
              nowMs={nowMs}
              pendingKinds={props.pendingApprovals?.get(session.id)}
              session={session}
            />
          );
        }}
      />
    </Box>
  );
}
