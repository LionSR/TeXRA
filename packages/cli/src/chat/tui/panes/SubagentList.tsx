// Persistent heterogeneous child-session and process list.

// Third-party imports
import { Box, Text, useInput } from 'ink';
import { useMemo } from 'react';

// Local imports - shared stream state
import type { ActiveChildInfo, StreamTabId } from '@shared/schemas';
import {
  formatRoundStageLabel,
  formatStreamStatusLabel,
} from '@shared/streams/streamStatusDisplay';
import { formatResultCount } from '@utils/text/stringUtils';

// Local imports - TUI state and controls
import {
  childElapsed,
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
  CHILD_STATUS_MARKER,
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
}: {
  readonly child: ActiveChildInfo;
  readonly nowMs: number;
  readonly tail?: ProcessOutputTail;
}): string {
  const tailSummary = processTailLines(tail).at(-1);
  const elapsed = childElapsed(child, nowMs);
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

function SessionRow({
  active,
  focused,
  hiddenRowSummary,
  nowMs,
  pendingKinds,
  session,
}: {
  readonly active: boolean;
  readonly focused: boolean;
  readonly hiddenRowSummary: string | undefined;
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
  // Significance order — truncate-end sheds elapsed first, then the round,
  // then the pending-approval kind.
  const approvalSuffix = pendingApprovalRowSuffix(pendingKinds);
  const roundLabel = formatRoundStageLabel(session.slice?.roundStage);
  return (
    <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
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
          {elapsed ? ` · ${elapsed}` : ''}
        </Text>
      </Box>
      {focused ? <HiddenRowSummary text={hiddenRowSummary} /> : null}
    </Box>
  );
}

function ProcessRow({
  child,
  focused,
  hiddenRowSummary,
  nowMs,
  tail,
}: {
  readonly child: ProcessChildInfo;
  readonly focused: boolean;
  readonly hiddenRowSummary: string | undefined;
  readonly nowMs: number;
  readonly tail?: ProcessOutputTail;
}): React.JSX.Element {
  return (
    <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
      <Text color={focused ? COLOR_HINT : undefined}>
        {focused ? POINTER : ' '}
      </Text>
      <Text>{'   '}</Text>
      <Text color={childStatusColor(child.status)}>{CHILD_STATUS_MARKER}</Text>
      <Box minWidth={0} flexShrink={1}>
        <Text wrap="truncate-end">
          {compactChildRowText({ child, nowMs, tail })}
        </Text>
      </Box>
      {focused ? <HiddenRowSummary text={hiddenRowSummary} /> : null}
    </Box>
  );
}

export interface SubagentListProps {
  readonly keyboardActive?: boolean;
  readonly maxRows?: number;
  readonly onCancel?: () => void;
  readonly onFocusStream?: (streamId: StreamTabId) => void;
  readonly onKillExecution?: (executionId: string) => void;
  readonly onOpenProcessDetail?: (executionId: string) => void;
  readonly onSelectionChange?: (value: ChildListValue) => void;
  readonly onViewStream?: (streamId: StreamTabId) => void;
  /** Pending approval kinds per stream id (see `pendingApprovalsByStream`,
   *  root bucket already folded onto the root stream id by the caller). */
  readonly pendingApprovals?: ReadonlyMap<
    string,
    readonly PendingApprovalKind[]
  >;
  readonly selectedValue?: ChildListValue;
  readonly sessions?: readonly StreamView[];
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
  const hiddenRowSummary = [
    hiddenSessionCount > 0
      ? `+${formatResultCount(hiddenSessionCount, 'session')}`
      : undefined,
    hiddenProcessCount > 0
      ? `+${formatResultCount(hiddenProcessCount, 'process')}`
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(', ');

  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return;
      const streamId = childListStreamId(props.selectedValue);
      if (input.toLowerCase() === 'v' && streamId) {
        props.onViewStream?.(streamId);
        return;
      }
      if (input.toLowerCase() !== 'k') return;
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
                active={state.active}
                focused={state.focused}
                hiddenRowSummary={hiddenRowSummary || undefined}
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
              hiddenRowSummary={hiddenRowSummary || undefined}
              nowMs={nowMs}
              tail={processOutput?.get(process.executionId)}
            />
          ) : null;
        }}
      />
    </Box>
  );
}
