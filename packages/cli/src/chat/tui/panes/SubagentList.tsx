// Persistent child-session list.

// Third-party imports
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMemo } from 'react';

// Local imports - shared stream state
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { POINTER, STATUS_DIAMOND, TICK } from '@cli/tui/ui/glyphs';
import {
  Select,
  visibleSelectRange,
  type SelectItem,
} from '@cli/tui/ui/Select';
import {
  AgentCategory,
  type StreamTabId,
  type WorkflowCallProgress,
} from '@shared/schemas';
import {
  formatWorkflowPhaseHeading,
  workflowPhaseCallProgress,
  type WorkflowPhaseHeading,
} from '@shared/copy/workflowCall';
import { formatStageLabel } from '@shared/streams/streamStatusDisplay';
import { formatResultCount } from '@utils/text/stringUtils';

// Local imports - TUI rendering
import { truncateSummaryToWidth } from '../render/terminalText';
import { formatCliStatusLabel } from '../sessionStatus';

// Local imports - TUI state and controls
import { childElapsed } from '../state/childControls';
import {
  childListStreamId,
  childPhaseListValue,
  childStreamListValue,
  type ChildListValue,
} from '../state/childListSelection';
import { useLiveNowMs } from '../state/useLiveNowMs';
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

interface PhaseHeaderDetails extends WorkflowPhaseHeading {
  readonly progress?: string;
}

function PhaseHeader({
  details,
  metadataColumn,
}: {
  readonly details: PhaseHeaderDetails;
  readonly metadataColumn: boolean;
}): React.JSX.Element {
  const inlineProgress =
    !metadataColumn && details.progress ? ` · ${details.progress}` : '';
  return (
    <Box flexDirection="row" flexGrow={1} minWidth={0}>
      <Box minWidth={0} flexShrink={1}>
        <Text dimColor wrap="truncate-end">
          {`    ${STATUS_DIAMOND} ${formatWorkflowPhaseHeading(details)}${inlineProgress}`}
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
  const substate = session.slice?.substate;
  const statusLabel = formatCliStatusLabel(
    status,
    substate,
    session.parentId !== undefined,
  );
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
  const stageLabel = formatStageLabel(session.slice?.stage);
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
  // Child rows summarize what the subagent is doing: the runtime's own
  // description (delegated task, or the generated session one-liner) when it
  // has one, otherwise the latest transcript line as live status. The
  // list-root row is the conversation itself — echoing its own last exchange
  // there is noise (and the root can itself be a nested subagent when focus
  // is scoped).
  const summary = isListRoot
    ? undefined
    : (session.slice?.description ?? session.slice?.latestLine);
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
    const phaseHeadings = new Map<string, WorkflowPhaseHeading>();
    const callsByPhase = new Map<string, WorkflowCallProgress[]>();
    for (const entry of entries) {
      if (entry.role === 'phase') {
        phaseHeadings.set(entry.phaseLabel, {
          phaseLabel: entry.phaseLabel,
          phaseIndex: entry.phaseIndex,
          phaseTotal: entry.phaseTotal,
        });
      } else if (
        entry.role === 'workflowTask' &&
        entry.task.phase !== undefined
      ) {
        const calls = callsByPhase.get(entry.task.phase);
        if (calls) calls.push(entry.task);
        else callsByPhase.set(entry.task.phase, [entry.task]);
      }
    }

    const nextItems: SelectItem<ChildListValue>[] = [];
    const nextHeaders = new Map<ChildListValue, PhaseHeaderDetails>();
    // A header only ever *opens* a group; nothing closes one. That is sound
    // only because `sessions` arrives from `streamTreeViews`, whose
    // `groupWorkflowPhaseEntries` makes same-phase rows contiguous and puts
    // every phase-less row ahead of the first group — so no row can land under
    // a header it does not belong to, and no phase can open a second header.
    // Order has one owner: do not re-sort here, it would desynchronise the
    // Alt+1..9 numbers `streamTreeEntries` assigns from the rows on screen.
    let previousPhase: string | undefined;
    let headerOrdinal = 0;
    for (const session of sessions) {
      const item = {
        label: session.label,
        value: childStreamListValue(session.id),
      };
      // The list root is context, not a grouped attempt. Every other row
      // already belongs to this root's visible current/retained descendant
      // set, including historical children promoted away from the root.
      if (session.id === props.listRootStreamId) {
        nextItems.push(item);
        continue;
      }
      const phase = session.workflowPhase;
      if (phase !== undefined && phase !== previousPhase) {
        const value = childPhaseListValue(headerOrdinal++);
        const calls = callsByPhase.get(phase) ?? [];
        const { done, total } = workflowPhaseCallProgress(calls);
        nextItems.push({ label: phase, value, disabled: true });
        nextHeaders.set(value, {
          ...(phaseHeadings.get(phase) ?? { phaseLabel: phase }),
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
      if (!streamId) return;
      const pressed = input.toLowerCase();
      if (pressed === 'v') {
        props.onPrintStream?.(streamId);
        return;
      }
      // Kill/skip/retry target only a focused subagent stream (a
      // workflow-script grandchild); the session control registry no-ops for
      // any execution id that is not an in-flight grandchild, so non-workflow
      // rows are inert.
      if (pressed !== 'k' && pressed !== 's' && pressed !== 'r') return;
      const executionId = props.activeSubagentExecutionIds?.get(streamId);
      if (!executionId) return;
      if (pressed === 'k') props.onKillExecution?.(executionId);
      else if (pressed === 's') props.onSkipExecution?.(executionId);
      else props.onRetryExecution?.(executionId);
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
