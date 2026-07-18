// Persistent heterogeneous child-session and process list.

// Third-party imports
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMemo } from 'react';

// Local imports - shared stream state
import type { ActiveChildInfo, StreamTabId } from '@shared/schemas';
import {
  formatRoundStageLabel,
  formatStreamStatusLabel,
} from '@shared/streams/streamStatusDisplay';
import { formatResultCount } from '@utils/text/stringUtils';

// Local imports - TUI rendering
import { truncateSummaryToWidth } from '../render/terminalText';

// Local imports - TUI state and controls
import {
  childElapsed,
  latestChildResponseSummary,
  liveChildExecutionElapsedKey,
  processTailLines,
} from '../state/childControls';
import { childExecutionLabel } from '../state/childExecutions';
import {
  childListProcessId,
  childListStreamId,
  childProcessListValue,
  childStreamListValue,
  type ChildListValue,
} from '../state/childListSelection';
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
import type { ProcessOutputTail } from '../state/cliState';
import type { StreamView } from '../state/streamViews';

type ProcessChildInfo = Extract<ActiveChildInfo, { kind: 'process' }>;

function childStatusLabel(status: string | undefined): string | undefined {
  return formatStreamStatusLabel(status, {
    style: 'cli',
    isChildStream: true,
  });
}

export function compactChildRowText({
  child,
  nowMs,
  tail,
  omitElapsed = false,
}: {
  readonly child: ActiveChildInfo;
  readonly nowMs: number;
  readonly tail?: ProcessOutputTail;
  /** When the row shows elapsed in a trailing metadata column instead. */
  readonly omitElapsed?: boolean;
}): string {
  const tailSummary = processTailLines(tail).at(-1);
  const elapsed = omitElapsed ? undefined : childElapsed(child, nowMs);
  const label = childExecutionLabel(child);
  const statusLabel = childStatusLabel(child.status);
  return [
    `${label}${statusLabel ? ` ${statusLabel}` : ''}`,
    elapsed,
    tailSummary,
  ]
    .filter(Boolean)
    .join(' · ');
}

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
  const roundLabel = formatRoundStageLabel(session.slice?.roundStage);
  // The resolved model is per-agent identity (a workflow run's grandchildren
  // can each resolve a different model); the list-root row is the conversation
  // itself, whose model already rides the status bar.
  const modelLabel = isListRoot ? undefined : session.slice?.model;
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
  const summary = isListRoot
    ? undefined
    : latestChildResponseSummary(session.slice?.entries);
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
          {roundLabel ? ` · ${roundLabel}` : ''}
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

function ProcessRow({
  child,
  focused,
  hiddenRowSummary,
  metadataColumn,
  nowMs,
  tail,
}: {
  readonly child: ProcessChildInfo;
  readonly focused: boolean;
  readonly hiddenRowSummary: string | undefined;
  readonly metadataColumn: boolean;
  readonly nowMs: number;
  readonly tail?: ProcessOutputTail;
}): React.JSX.Element {
  // Raw processes report no token usage, so their metadata column is elapsed
  // only. Adding usage would need the runtime to stamp it onto the roster
  // entry (`ActiveChildInfo`).
  const metadata = metadataColumn
    ? childRowMetadataText({
        elapsed: childElapsed(child, nowMs),
        outputTokens: undefined,
      })
    : undefined;
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
      <Text>{'   '}</Text>
      <Text color={childStatusColor(child.status)}>{CHILD_STATUS_MARKER}</Text>
      <Box minWidth={0} flexShrink={1}>
        <Text wrap="truncate-end">
          {compactChildRowText({
            child,
            nowMs,
            tail,
            omitElapsed: metadataColumn,
          })}
        </Text>
      </Box>
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
  readonly onOpenProcessDetail?: (executionId: string) => void;
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
  readonly activeProcesses?: readonly ActiveChildInfo[];
  readonly activeSubagentExecutionIds?: ReadonlyMap<StreamTabId, string>;
  readonly processOutput?: ReadonlyMap<string, ProcessOutputTail>;
}

export function SubagentList(
  props: SubagentListProps = {},
): React.JSX.Element | null {
  const sessions = props.sessions ?? [];
  const activeProcesses = useMemo(
    () =>
      (props.activeProcesses ?? []).filter(
        (child): child is ProcessChildInfo => child.kind === 'process',
      ),
    [props.activeProcesses],
  );
  const processOutput = props.processOutput;
  const liveElapsedKey = useMemo(() => {
    const liveSessionStarts = sessions
      .map((session) => session.slice?.runStartedAt)
      .filter((startedAt): startedAt is number => startedAt !== undefined);
    return (
      [liveChildExecutionElapsedKey([], activeProcesses), ...liveSessionStarts]
        .filter((key) => key !== undefined)
        .join(':') || undefined
    );
  }, [activeProcesses, sessions]);
  const items = useMemo(
    () => [
      ...sessions.map((session) => ({
        label: session.label,
        value: childStreamListValue(session.id),
      })),
      ...activeProcesses.map((process) => ({
        label: childExecutionLabel(process),
        value: childProcessListValue(process.executionId),
      })),
    ],
    [activeProcesses, sessions],
  );
  const sessionsByValue = useMemo(
    () =>
      new Map(
        sessions.map((session) => [childStreamListValue(session.id), session]),
      ),
    [sessions],
  );
  const processesByValue = useMemo(
    () =>
      new Map(
        activeProcesses.map((process) => [
          childProcessListValue(process.executionId),
          process,
        ]),
      ),
    [activeProcesses],
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
  const hiddenProcessCount = activeProcesses.filter(
    (process) => !visibleValues.has(childProcessListValue(process.executionId)),
  ).length;
  const hiddenRowSummary =
    [
      hiddenSessionCount > 0
        ? `+${formatResultCount(hiddenSessionCount, 'session')}`
        : undefined,
      hiddenProcessCount > 0
        ? `+${formatResultCount(hiddenProcessCount, 'process')}`
        : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(', ') || undefined;

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
      const processId = childListProcessId(props.selectedValue);
      let executionId: string | undefined;
      if (processId && props.selectedValue) {
        executionId = processesByValue.get(props.selectedValue)?.executionId;
      } else if (streamId) {
        executionId = props.activeSubagentExecutionIds?.get(streamId);
      }
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
        onHighlightChange={(value) => props.onSelectionChange?.(value)}
        onSelect={(value) => {
          const streamId = childListStreamId(value);
          if (streamId) {
            props.onFocusStream?.(streamId);
            return;
          }
          const executionId = childListProcessId(value);
          if (executionId) props.onOpenProcessDetail?.(executionId);
        }}
        renderItem={(item, state) => {
          const session = sessionsByValue.get(item.value);
          if (session) {
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
          }
          const process = processesByValue.get(item.value);
          return process ? (
            <ProcessRow
              child={process}
              focused={state.focused}
              hiddenRowSummary={hiddenRowSummary}
              metadataColumn={metadataColumn}
              nowMs={nowMs}
              tail={processOutput?.get(process.executionId)}
            />
          ) : null;
        }}
      />
    </Box>
  );
}
