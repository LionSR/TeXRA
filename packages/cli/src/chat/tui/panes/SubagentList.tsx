// Lists active subagents + processes for the currently-focused stream and
// tails the live stdout/stderr per process so the user can see what each
// shell call is doing.
//
// The leading numeric index is currently a visual cue only.

import { Box, Text } from 'ink';

import type { ActiveChildInfo } from '@shared/schemas';

import {
  childElapsed,
  liveChildExecutionElapsedKey,
  processTailLines,
} from '../state/childControls';
import { visibleSubagentRows } from '../state/childStreamMerge';
import { cliState, type ProcessOutputTail } from '../state/cliState';
import { useLiveNowMs } from '../state/useLiveNowMs';
import { useSignal } from '../state/useSignal';
import {
  CHILD_STATUS_MARKER,
  childStatusColor,
  shouldShowChildSectionHeader,
} from './SubagentListDisplay';

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
  readonly tail?: ProcessOutputTail;
}

const TAIL_LINES = 4;

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
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dimColor>{index < 9 ? ` ${index + 1} ` : '   '}</Text>
        <Text color={childStatusColor(child.status)}>
          {CHILD_STATUS_MARKER}
        </Text>
        <Text>{child.agentName || child.toolName || child.executionId}</Text>
        {child.status ? <Text dimColor>{` ${child.status}`}</Text> : null}
        {elapsed ? <Text dimColor>{` · ${elapsed}`}</Text> : null}
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
  readonly processOutput: ReadonlyMap<string, ProcessOutputTail> | undefined;
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
      tail: params.processOutput?.get(child.executionId),
    })),
  ];
  if (allRows.length <= rowBudget) {
    return { hiddenCount: 0, rows: allRows };
  }
  if (rowBudget <= 1) {
    return {
      hiddenCount: allRows.length,
      rows: [],
    };
  }
  const visibleRows = allRows.slice(0, rowBudget - 1);
  return {
    hiddenCount: allRows.length - visibleRows.length,
    rows: visibleRows,
  };
}

export interface SubagentListProps {
  readonly maxRows?: number;
}

export function SubagentList(
  props: SubagentListProps = {},
): React.JSX.Element | null {
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const activeProcesses = slice?.activeProcesses ?? [];
  const processOutput = slice?.processOutput;
  const subagents = slice ? visibleSubagentRows(slice) : [];
  const liveElapsedKey = liveChildExecutionElapsedKey(slice);
  const nowMs = useLiveNowMs(liveElapsedKey !== undefined, liveElapsedKey);
  const showSectionHeader = shouldShowChildSectionHeader(props.maxRows);

  if (!slice) return null;
  if (subagents.length === 0 && activeProcesses.length === 0) return null;
  if (props.maxRows !== undefined && props.maxRows <= 0) return null;

  if (props.maxRows !== undefined) {
    const { hiddenCount, rows } = compactRows({
      activeProcesses,
      maxRows: props.maxRows,
      processOutput,
      subagents,
    });
    return (
      <Box
        flexDirection="column"
        height={props.maxRows}
        overflowY="hidden"
        paddingX={1}
      >
        {rows.map(({ child, index, tail }) => (
          <Row
            key={child.executionId}
            child={child}
            compact
            index={index}
            nowMs={nowMs}
            tail={tail}
          />
        ))}
        {hiddenCount > 0 ? (
          <Text
            dimColor
          >{`   +${hiddenCount} more child execution${hiddenCount === 1 ? '' : 's'}`}</Text>
        ) : null}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      height={props.maxRows}
      overflowY={props.maxRows === undefined ? undefined : 'hidden'}
      paddingX={1}
      marginBottom={props.maxRows === undefined ? 1 : 0}
    >
      {subagents.length > 0 ? (
        <Box flexDirection="column">
          {showSectionHeader ? (
            <Text bold dimColor>
              Subagents
            </Text>
          ) : null}
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
          {showSectionHeader ? (
            <Text bold dimColor>
              Processes
            </Text>
          ) : null}
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
