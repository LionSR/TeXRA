// Interactive list of sessions AND active processes — the single navigation
// home for child work: Enter focuses a session or opens a process's detail
// view, `k` kills the highlighted killable row.

// Third-party imports
import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';

// Local imports - shared stream state
import { formatStreamStatusLabel } from '@shared/streams/streamStatusDisplay';

// Local imports - TUI state and controls
import {
  childElapsed,
  latestChildResponseSummary,
  liveChildExecutionElapsedKey,
  processTailLines,
  SUBAGENT_SUMMARY_MAX_COLUMNS,
} from '../state/childControls';
import { childExecutionLabel } from '../state/childExecutions';
import { subagentListRowStreamId } from '../state/subagentListRows';
import { useLiveNowMs } from '../state/useLiveNowMs';
import { truncateSummaryToWidth } from '../render/terminalText';
import { COLOR_HINT } from '../ui/colors';
import { POINTER, TICK } from '../ui/glyphs';
import { Select } from '../ui/Select';
import { CHILD_STATUS_MARKER, childStatusColor } from './SubagentListDisplay';
import type { ActiveChildInfo } from '@shared/schemas';
import type { ProcessOutputTail } from '../state/cliState';
import type { SubagentListRow } from '../state/subagentListRows';
import type { StreamView } from '../state/streamViews';

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
  hiddenRowCount,
  nowMs,
  session,
}: {
  readonly active: boolean;
  readonly focused: boolean;
  readonly hiddenRowCount: number;
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
  // Child rows summarize what the subagent last said; the root row is the
  // conversation itself — echoing your own last message there is noise.
  const summary =
    session.parentId !== undefined
      ? latestChildResponseSummary(session.slice?.entries)
      : undefined;
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
      {summary ? (
        <Box minWidth={0} flexShrink={2}>
          <Text dimColor wrap="truncate-end">
            {` · ${truncateSummaryToWidth(summary, SUBAGENT_SUMMARY_MAX_COLUMNS)}`}
          </Text>
        </Box>
      ) : null}
      {focused && hiddenRowCount > 0 ? (
        <Box flexShrink={0}>
          <Text dimColor>{` · +${hiddenRowCount} more`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function ProcessRow({
  child,
  focused,
  hiddenRowCount,
  nowMs,
  tail,
}: {
  readonly child: ActiveChildInfo;
  readonly focused: boolean;
  readonly hiddenRowCount: number;
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
      {focused && hiddenRowCount > 0 ? (
        <Box flexShrink={0}>
          <Text dimColor>{` · +${hiddenRowCount} more`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export interface SubagentListProps {
  readonly keyboardActive?: boolean;
  readonly maxRows?: number;
  readonly onCancel?: () => void;
  readonly onFocusStream?: (streamId: StreamView['id']) => void;
  readonly onKillExecution?: (executionId: string) => void;
  readonly onOpenTaskDetail?: (executionId: string) => void;
  readonly onSelectionChange?: (streamId: StreamView['id']) => void;
  readonly processOutput?: ReadonlyMap<string, ProcessOutputTail>;
  readonly rows?: readonly SubagentListRow[];
  readonly selectedStreamId?: StreamView['id'];
}

export function SubagentList(
  props: SubagentListProps = {},
): React.JSX.Element | null {
  const rows = props.rows ?? [];
  const processOutput = props.processOutput;
  // Mirrors Select's internal highlight so the `k` handler knows its target;
  // Select remains the single owner of arrow-key movement.
  const [highlightedKey, setHighlightedKey] = useState<string | undefined>(
    undefined,
  );
  const rowsByKey = useMemo(
    () => new Map(rows.map((row) => [row.key, row])),
    [rows],
  );
  const liveElapsedKey = useMemo(() => {
    const liveSessionStarts = rows.flatMap((row) =>
      row.kind === 'session' && row.session.slice?.runStartedAt !== undefined
        ? [row.session.slice.runStartedAt]
        : [],
    );
    const processes = rows.flatMap((row) =>
      row.kind === 'process' ? [row.child] : [],
    );
    return (
      [liveChildExecutionElapsedKey([], processes), ...liveSessionStarts]
        .filter((key) => key !== undefined)
        .join(':') || undefined
    );
  }, [rows]);
  const items = useMemo(
    () =>
      rows.map((row) => ({
        label:
          row.kind === 'session'
            ? row.session.label
            : childExecutionLabel(row.child),
        value: row.key,
      })),
    [rows],
  );
  const nowMs = useLiveNowMs(liveElapsedKey !== undefined, liveElapsedKey);

  const keyboardActive = props.keyboardActive === true;
  useInput(
    (input) => {
      if (input.toLowerCase() !== 'k') return;
      const row =
        highlightedKey !== undefined ? rowsByKey.get(highlightedKey) : rows[0];
      if (!row || !row.killable) return;
      const executionId =
        row.kind === 'process' ? row.child.executionId : row.executionId;
      if (executionId !== undefined) props.onKillExecution?.(executionId);
    },
    { isActive: keyboardActive },
  );

  if (rows.length === 0) return null;
  if (props.maxRows !== undefined && props.maxRows <= 0) return null;

  const activeSessionKey = rows.find(
    (row) => row.kind === 'session' && row.session.active,
  )?.key;
  return (
    <Box
      flexDirection="column"
      height={props.maxRows}
      overflowY={props.maxRows === undefined ? undefined : 'hidden'}
      paddingX={1}
    >
      <Select
        activeValue={activeSessionKey}
        highlightedValue={
          props.selectedStreamId !== undefined
            ? `session:${props.selectedStreamId}`
            : undefined
        }
        hotkeys={false}
        isActive={keyboardActive}
        items={items}
        maxVisibleItems={props.maxRows}
        onCancel={props.onCancel ?? (() => undefined)}
        onHighlightChange={(key) => {
          setHighlightedKey(key);
          const row = rowsByKey.get(key);
          const streamId = row ? subagentListRowStreamId(row) : undefined;
          if (streamId !== undefined) props.onSelectionChange?.(streamId);
        }}
        onSelect={(key) => {
          const row = rowsByKey.get(key);
          if (!row) return;
          if (row.kind === 'session') {
            props.onFocusStream?.(row.session.id);
          } else {
            props.onOpenTaskDetail?.(row.child.executionId);
          }
        }}
        renderItem={(item, state) => {
          const row = rowsByKey.get(item.value);
          if (!row) return null;
          return row.kind === 'session' ? (
            <SessionRow
              active={state.active}
              focused={state.focused}
              hiddenRowCount={state.hiddenItemCount}
              nowMs={nowMs}
              session={row.session}
            />
          ) : (
            <ProcessRow
              child={row.child}
              focused={state.focused}
              hiddenRowCount={state.hiddenItemCount}
              nowMs={nowMs}
              tail={processOutput?.get(row.child.executionId)}
            />
          );
        }}
      />
    </Box>
  );
}
