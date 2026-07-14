// Interactive session list plus non-selectable active process rows.

import { Box, Text } from 'ink';

import type { ActiveChildInfo } from '@shared/schemas';
import { formatStreamStatusLabel } from '@shared/streams/streamStatusDisplay';

import {
  childElapsed,
  liveChildExecutionElapsedKey,
  processTailLines,
} from '../state/childControls';
import { childExecutionLabel } from '../state/childExecutions';
import { useLiveNowMs } from '../state/useLiveNowMs';
import { COLOR_HINT } from '../ui/colors';
import { POINTER, TICK } from '../ui/glyphs';
import { Select } from '../ui/Select';
import { CHILD_STATUS_MARKER, childStatusColor } from './SubagentListDisplay';
import type { ProcessOutputTail } from '../state/cliState';
import type { StreamView } from '../state/streamViews';

interface ProcessRowProps {
  readonly child: ActiveChildInfo;
  readonly nowMs: number;
  readonly tail?: ProcessOutputTail;
}

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

function SessionRow({
  active,
  focused,
  nowMs,
  session,
}: {
  readonly active: boolean;
  readonly focused: boolean;
  readonly nowMs: number;
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
  return (
    <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
      <Text color={focused ? COLOR_HINT : undefined}>
        {focused ? POINTER : ' '}
      </Text>
      <Text color={active ? COLOR_HINT : undefined}>
        {active ? ` ${TICK} ` : '   '}
      </Text>
      <Text color={childStatusColor(status)}>{CHILD_STATUS_MARKER}</Text>
      <Text bold={active} wrap="truncate-end">
        {session.label}
        {statusLabel ? ` ${statusLabel}` : ''}
        {elapsed ? ` · ${elapsed}` : ''}
      </Text>
    </Box>
  );
}

function ProcessRow({
  child,
  nowMs,
  tail,
}: ProcessRowProps): React.JSX.Element {
  return (
    <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
      <Text>{'    '}</Text>
      <Text color={childStatusColor(child.status)}>{CHILD_STATUS_MARKER}</Text>
      <Text wrap="truncate-end">
        {compactChildRowText({ child, nowMs, tail })}
      </Text>
    </Box>
  );
}

/**
 * Natural row count: one row per session and active process.
 */
export function subagentPanelRowCount(
  sessions: readonly StreamView[],
  activeProcesses: readonly ActiveChildInfo[],
): number {
  return sessions.length + activeProcesses.length;
}

export interface SubagentListProps {
  readonly keyboardActive?: boolean;
  readonly maxRows?: number;
  readonly onCancel?: () => void;
  readonly onFocusStream?: (streamId: StreamView['id']) => void;
  readonly onSelectionChange?: (streamId: StreamView['id']) => void;
  readonly selectedStreamId?: StreamView['id'];
  readonly sessions?: readonly StreamView[];
  readonly activeProcesses?: readonly ActiveChildInfo[];
  readonly processOutput?: ReadonlyMap<string, ProcessOutputTail>;
}

export function SubagentList(
  props: SubagentListProps = {},
): React.JSX.Element | null {
  const sessions = props.sessions ?? [];
  const activeProcesses = props.activeProcesses ?? [];
  const processOutput = props.processOutput;
  const liveSessionStarts = sessions
    .map((session) => session.slice?.runStartedAt)
    .filter((startedAt): startedAt is number => startedAt !== undefined);
  const liveElapsedKey =
    [liveChildExecutionElapsedKey([], activeProcesses), ...liveSessionStarts]
      .filter((key) => key !== undefined)
      .join(':') || undefined;
  const nowMs = useLiveNowMs(liveElapsedKey !== undefined, liveElapsedKey);

  if (sessions.length === 0 && activeProcesses.length === 0) return null;
  if (props.maxRows !== undefined && props.maxRows <= 0) return null;

  const sessionRowBudget =
    props.maxRows === undefined
      ? sessions.length
      : Math.min(sessions.length, Math.max(0, Math.floor(props.maxRows)));
  const processRowBudget =
    props.maxRows === undefined
      ? activeProcesses.length
      : Math.max(0, Math.floor(props.maxRows) - sessionRowBudget);
  const visibleProcesses = activeProcesses.slice(0, processRowBudget);
  const sessionsById = new Map(
    sessions.map((session) => [session.id, session]),
  );

  return (
    <Box
      flexDirection="column"
      height={props.maxRows}
      overflowY={props.maxRows === undefined ? undefined : 'hidden'}
      paddingX={1}
    >
      {sessions.length > 0 ? (
        <Select
          activeValue={sessions.find((session) => session.active)?.id}
          highlightedValue={props.selectedStreamId}
          hotkeys={false}
          isActive={props.keyboardActive}
          items={sessions.map((session) => ({
            label: session.label,
            value: session.id,
          }))}
          maxVisibleItems={sessionRowBudget}
          onCancel={props.onCancel ?? (() => undefined)}
          onHighlightChange={(streamId) => props.onSelectionChange?.(streamId)}
          onSelect={(streamId) => props.onFocusStream?.(streamId)}
          renderItem={(item, state) => {
            const session = sessionsById.get(item.value);
            return session ? (
              <SessionRow
                active={state.active}
                focused={state.focused}
                nowMs={nowMs}
                session={session}
              />
            ) : null;
          }}
        />
      ) : null}
      {visibleProcesses.map((child) => (
        <ProcessRow
          key={child.executionId}
          child={child}
          nowMs={nowMs}
          tail={processOutput?.get(child.executionId)}
        />
      ))}
    </Box>
  );
}
