// Persistent child-session list.

// Third-party imports
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMemo } from 'react';

// Local imports - shared stream state
import {
  AgentCategory,
  type StreamTabId,
  type WorkflowTaskProgress,
} from '@shared/schemas';
import { workflowPhaseTaskProgress } from '@shared/copy/workflowTask';
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
import { useLiveNowMs } from '../state/useLiveNowMs';
import { COLOR_HINT } from '../ui/colors';
import { POINTER, STATUS_DIAMOND, TICK } from '../ui/glyphs';
import { Select, visibleSelectRange, type SelectItem } from '../ui/Select';
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

interface PhaseHeaderDetails {
  readonly label: string;
  readonly index?: number;
  readonly total?: number;
  readonly progress?: string;
}

function PhaseHeader({
  details,
  metadataColumn,
}: {
  readonly details: PhaseHeaderDetails;
  readonly metadataColumn: boolean;
}): React.JSX.Element {
  const position =
    details.index !== undefined && details.total !== undefined
      ? ` (${details.index + 1}/${details.total})`
      : '';
  const inlineProgress =
    !metadataColumn && details.progress ? ` · ${details.progress}` : '';
  return (
    <Box flexDirection="row" flexGrow={1} minWidth={0}>
      <Box minWidth={0} flexShrink={1}>
        <Text dimColor wrap="truncate-end">
          {`    ${STATUS_DIAMOND} ${details.label}${position}${inlineProgress}`}
        </Text>
      </Box>
      {metadataColumn && details.progress ? (
        <>
          <Box flexGrow={1} />
          <Box flexShrink={0}>
            <Text dimColor>{`  ${details.progress}`}</Text>
          </Box>
        </>
      ) : null}
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
  const { items, phaseHeadersByValue } = useMemo(() => {
    const rootSession = sessions.find(
      (session) => session.id === props.listRootStreamId,
    );
    const entries =
      rootSession?.slice?.category === AgentCategory.Workflow
        ? rootSession.slice.entries
        : [];
    const phasePositions = new Map<
      string,
      { readonly index?: number; readonly total?: number }
    >();
    const tasksByPhase = new Map<string, WorkflowTaskProgress[]>();
    for (const entry of entries) {
      if (entry.role === 'phase') {
        phasePositions.set(entry.phaseLabel, {
          index: entry.phaseIndex,
          total: entry.phaseTotal,
        });
      } else if (
        entry.role === 'workflowTask' &&
        entry.task.phase !== undefined
      ) {
        const tasks = tasksByPhase.get(entry.task.phase);
        if (tasks) tasks.push(entry.task);
        else tasksByPhase.set(entry.task.phase, [entry.task]);
      }
    }

    const nextItems: SelectItem<ChildListValue>[] = [];
    const nextHeaders = new Map<ChildListValue, PhaseHeaderDetails>();
    let previousPhase: string | undefined;
    let headerOrdinal = 0;
    for (const session of sessions) {
      const item = {
        label: session.label,
        value: childStreamListValue(session.id),
      };
      // The list root is context, not a grouped attempt. Likewise, only its
      // direct children can belong to this focused workflow run's phases.
      if (
        session.id === props.listRootStreamId ||
        session.parentId !== props.listRootStreamId
      ) {
        nextItems.push(item);
        continue;
      }
      const phase = session.workflowPhase;
      if (phase !== undefined && phase !== previousPhase) {
        const value = childPhaseListValue(headerOrdinal++);
        const tasks = tasksByPhase.get(phase) ?? [];
        const { done, total } = workflowPhaseTaskProgress(tasks);
        const position = phasePositions.get(phase);
        nextItems.push({ label: phase, value, disabled: true });
        nextHeaders.set(value, {
          label: phase,
          index: position?.index,
          total: position?.total,
          ...(total > 0 ? { progress: `${done}/${total}` } : {}),
        });
      }
      nextItems.push(item);
      previousPhase = phase;
    }
    return { items: nextItems, phaseHeadersByValue: nextHeaders };
  }, [props.listRootStreamId, sessions]);
  const sessionsByValue = useMemo(
    () =>
      new Map(
        sessions.map((session) => [childStreamListValue(session.id), session]),
      ),
    [sessions],
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
          const phaseHeader = phaseHeadersByValue.get(item.value);
          if (phaseHeader) {
            return (
              <PhaseHeader
                details={phaseHeader}
                metadataColumn={metadataColumn}
              />
            );
          }
          const session = sessionsByValue.get(item.value);
          return session ? (
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
          ) : null;
        }}
      />
    </Box>
  );
}
