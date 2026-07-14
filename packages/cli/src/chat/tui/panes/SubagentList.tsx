// Interactive session list plus non-selectable active process rows.

import { Box, Text } from 'ink';
import { useMemo } from 'react';

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
  hiddenSessionCount,
  nowMs,
  processSummary,
  session,
}: {
  readonly active: boolean;
  readonly focused: boolean;
  readonly hiddenSessionCount: number;
  readonly nowMs: number;
  readonly processSummary?: string;
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
      <Box minWidth={0} flexShrink={1}>
        <Text bold={active} wrap="truncate-end">
          {session.label}
          {statusLabel ? ` ${statusLabel}` : ''}
          {elapsed ? ` · ${elapsed}` : ''}
        </Text>
      </Box>
      {focused && (hiddenSessionCount > 0 || processSummary) ? (
        <Box flexShrink={0}>
          <Text dimColor>
            {` · ${[
              hiddenSessionCount > 0
                ? `+${hiddenSessionCount} session${hiddenSessionCount === 1 ? '' : 's'}`
                : undefined,
              processSummary,
            ]
              .filter(Boolean)
              .join(', ')}`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function ProcessRow({
  child,
  hiddenProcessCount = 0,
  nowMs,
  tail,
}: ProcessRowProps & {
  readonly hiddenProcessCount?: number;
}): React.JSX.Element {
  return (
    <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
      <Text>{'    '}</Text>
      <Text color={childStatusColor(child.status)}>{CHILD_STATUS_MARKER}</Text>
      <Box minWidth={0} flexShrink={1}>
        <Text wrap="truncate-end">
          {compactChildRowText({ child, nowMs, tail })}
        </Text>
      </Box>
      {hiddenProcessCount > 0 ? (
        <Box flexShrink={0}>
          <Text
            dimColor
          >{` · +${hiddenProcessCount} more process${hiddenProcessCount === 1 ? '' : 'es'}`}</Text>
        </Box>
      ) : null}
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

export function subagentListRowAllocation({
  maxRows,
  processCount,
  sessionCount,
}: {
  readonly maxRows: number | undefined;
  readonly processCount: number;
  readonly sessionCount: number;
}): {
  readonly processRows: number;
  readonly sessionRows: number;
} {
  if (maxRows === undefined) {
    return { processRows: processCount, sessionRows: sessionCount };
  }
  const rows = Math.max(0, Math.floor(maxRows));
  if (sessionCount === 0) {
    return { processRows: Math.min(processCount, rows), sessionRows: 0 };
  }

  // A focused list must always retain a selectable session row. When there is
  // another row, reserve it for process visibility before filling the
  // remaining space with sessions.
  const reservedProcessRows = processCount > 0 && rows > 1 ? 1 : 0;
  const sessionRows = Math.min(
    sessionCount,
    Math.max(0, rows - reservedProcessRows),
  );
  return {
    processRows: Math.min(processCount, rows - sessionRows),
    sessionRows,
  };
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
  const sessionItems = useMemo(
    () =>
      sessions.map((session) => ({
        label: session.label,
        value: session.id,
      })),
    [sessions],
  );
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const nowMs = useLiveNowMs(liveElapsedKey !== undefined, liveElapsedKey);

  if (sessions.length === 0 && activeProcesses.length === 0) return null;
  if (props.maxRows !== undefined && props.maxRows <= 0) return null;

  const { processRows, sessionRows } = subagentListRowAllocation({
    maxRows: props.maxRows,
    processCount: activeProcesses.length,
    sessionCount: sessions.length,
  });
  const visibleProcesses = activeProcesses.slice(0, processRows);
  const hiddenProcessCount = activeProcesses.length - visibleProcesses.length;
  const processSummary =
    hiddenProcessCount > 0 && visibleProcesses.length === 0
      ? `+${hiddenProcessCount} process${hiddenProcessCount === 1 ? '' : 'es'}`
      : undefined;
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
          items={sessionItems}
          maxVisibleItems={sessionRows}
          onCancel={props.onCancel ?? (() => undefined)}
          onHighlightChange={(streamId) => props.onSelectionChange?.(streamId)}
          onSelect={(streamId) => props.onFocusStream?.(streamId)}
          renderItem={(item, state) => {
            const session = sessionsById.get(item.value);
            return session ? (
              <SessionRow
                active={state.active}
                focused={state.focused}
                hiddenSessionCount={state.hiddenItemCount}
                nowMs={nowMs}
                processSummary={processSummary}
                session={session}
              />
            ) : null;
          }}
        />
      ) : null}
      {visibleProcesses.map((child, index) => (
        <ProcessRow
          key={child.executionId}
          child={child}
          hiddenProcessCount={
            index === visibleProcesses.length - 1 ? hiddenProcessCount : 0
          }
          nowMs={nowMs}
          tail={processOutput?.get(child.executionId)}
        />
      ))}
    </Box>
  );
}
