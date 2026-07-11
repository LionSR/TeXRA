// Lists active subagents + processes for the currently-focused stream and
// tails the live stdout/stderr per process so the user can see what each
// shell call is doing.
//
// The leading numeric index is currently a visual cue only.

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
import { CHILD_STATUS_MARKER, childStatusColor } from './SubagentListDisplay';
import type { ProcessOutputTail } from '../state/cliState';

interface RowProps {
  readonly child: ActiveChildInfo;
  readonly index: number;
  readonly nowMs: number;
  readonly compact?: boolean;
  readonly tail?: ProcessOutputTail;
}

export interface ChildRow {
  readonly child: ActiveChildInfo;
  readonly index: number;
}

const TAIL_LINES = 4;

function childStatusLabel(status: string | undefined): string | undefined {
  // Every row in this panel is a child/subagent stream, never the root
  // session, so WAITING always gets the distinct child-waiting wording.
  return formatStreamStatusLabel(status, { style: 'cli', isChildStream: true });
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

function Row({
  child,
  compact = false,
  index,
  nowMs,
  tail,
}: RowProps): React.JSX.Element {
  // The state layer already caps each stream at PROCESS_TAIL_CHARS_MAX, so
  // pulling the last `TAIL_LINES` non-blank lines is bounded work.
  const tailLines = compact ? [] : processTailLines(tail).slice(-TAIL_LINES);
  const elapsed = childElapsed(child, nowMs);
  const label = childExecutionLabel(child);
  const statusLabel = childStatusLabel(child.status);
  return (
    <Box
      flexDirection="column"
      height={compact ? 1 : undefined}
      overflowY={compact ? 'hidden' : undefined}
    >
      <Box flexDirection="row" minWidth={0}>
        <Text dimColor>{index < 9 ? ` ${index + 1} ` : '   '}</Text>
        <Text color={childStatusColor(child.status)}>
          {CHILD_STATUS_MARKER}
        </Text>
        {compact ? (
          <Text wrap="truncate-end">
            {compactChildRowText({ child, nowMs, tail })}
          </Text>
        ) : (
          <>
            <Text>{label}</Text>
            {statusLabel ? <Text dimColor>{` ${statusLabel}`}</Text> : null}
            {elapsed ? <Text dimColor>{` · ${elapsed}`}</Text> : null}
          </>
        )}
      </Box>
      {tailLines.length > 0 ? (
        <Box flexDirection="column" marginLeft={4}>
          {tailLines.map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

export function compactRows(params: {
  readonly activeProcesses: readonly ActiveChildInfo[];
  readonly maxRows: number;
  readonly subagents: readonly ActiveChildInfo[];
}): {
  readonly hiddenCount: number;
  readonly rows: readonly ChildRow[];
} {
  const rowBudget = Math.max(0, Math.floor(params.maxRows));
  const allRows: ChildRow[] = [
    ...params.subagents.map((child, index) => ({ child, index })),
    ...params.activeProcesses.map((child, processIndex) => ({
      child,
      index: params.subagents.length + processIndex,
    })),
  ];
  if (allRows.length <= rowBudget) {
    return { hiddenCount: 0, rows: allRows };
  }
  if (rowBudget <= 0) {
    return { hiddenCount: allRows.length, rows: [] };
  }
  // At one row, show the highest-signal item (the first row — already
  // priority-ordered by the caller's active overlay) instead of spending the
  // only row on the hidden-count marker. Mirrors TodosPlanPanel's
  // `compactTodosPlanRows`, the other bottom panel sharing this row budget.
  const visibleCount = rowBudget === 1 ? 1 : rowBudget - 1;
  const visibleRows = allRows.slice(0, visibleCount);
  return {
    hiddenCount: allRows.length - visibleRows.length,
    rows: visibleRows,
  };
}

/**
 * Natural (uncapped) compact-row count: one row per visible subagent and
 * active process. Drives the bottom-panel reservation in App so the panel
 * takes only the height it needs.
 */
export function subagentPanelRowCount(
  subagents: readonly ActiveChildInfo[],
  activeProcesses: readonly ActiveChildInfo[],
): number {
  return subagents.length + activeProcesses.length;
}

export interface SubagentListProps {
  readonly maxRows?: number;
  /** Already-derived visible subagent rows (retained order, active overlay)
   *  for the target parent stream — computed once by the caller from
   *  `childExecutions.ts#visibleSubagentRows` so this stays a stateless
   *  props-in renderer. */
  readonly subagents?: readonly ActiveChildInfo[];
  readonly activeProcesses?: readonly ActiveChildInfo[];
  readonly processOutput?: ReadonlyMap<string, ProcessOutputTail>;
}

export function SubagentList(
  props: SubagentListProps = {},
): React.JSX.Element | null {
  const subagents = props.subagents ?? [];
  const activeProcesses = props.activeProcesses ?? [];
  const processOutput = props.processOutput;
  const liveElapsedKey = liveChildExecutionElapsedKey(
    subagents,
    activeProcesses,
  );
  const nowMs = useLiveNowMs(liveElapsedKey !== undefined, liveElapsedKey);

  if (subagents.length === 0 && activeProcesses.length === 0) return null;
  if (props.maxRows !== undefined && props.maxRows <= 0) return null;

  if (props.maxRows !== undefined) {
    const { hiddenCount, rows } = compactRows({
      activeProcesses,
      maxRows: props.maxRows,
      subagents,
    });
    return (
      <Box
        flexDirection="column"
        height={props.maxRows}
        overflowY="hidden"
        paddingX={1}
      >
        {rows.map(({ child, index }) => (
          <Row
            key={child.executionId}
            child={child}
            compact
            index={index}
            nowMs={nowMs}
            tail={processOutput?.get(child.executionId)}
          />
        ))}
        {hiddenCount > 0 ? (
          <Text
            dimColor
            wrap="truncate-end"
          >{`   … +${hiddenCount} more child execution${hiddenCount === 1 ? '' : 's'}`}</Text>
        ) : null}
      </Box>
    );
  }

  // Reached only when maxRows is undefined (the compact branch above owns every
  // bounded case), so the panel renders uncapped with a trailing margin.
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {subagents.length > 0 ? (
        <Box flexDirection="column">
          <Text bold dimColor>
            Subagents
          </Text>
          {subagents.map((child, i) => (
            <Row
              key={child.executionId}
              child={child}
              index={i}
              nowMs={nowMs}
            />
          ))}
        </Box>
      ) : null}
      {activeProcesses.length > 0 ? (
        <Box flexDirection="column" marginTop={subagents.length > 0 ? 1 : 0}>
          <Text bold dimColor>
            Processes
          </Text>
          {activeProcesses.map((child, i) => (
            <Row
              key={child.executionId}
              child={child}
              index={subagents.length + i}
              nowMs={nowMs}
              tail={processOutput?.get(child.executionId)}
            />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
