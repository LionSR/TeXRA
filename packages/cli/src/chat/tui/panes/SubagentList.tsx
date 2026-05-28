// Lists active subagents + processes for the currently-focused stream and
// tails the live stdout/stderr per process so the user can see what each
// shell call is doing.
//
// The leading numeric index is currently a visual cue only.

import { Box, Text } from 'ink';

import type { ActiveChildInfo } from '@shared/schemas';

import { processTailLines } from '../state/childControls';
import { visibleSubagentRows } from '../state/childStreamMerge';
import { cliState, type ProcessOutputTail } from '../state/cliState';
import { useSignal } from '../state/useSignal';
import { childStatusColor, childStatusMarker } from './SubagentListDisplay';

interface RowProps {
  readonly child: ActiveChildInfo;
  readonly index: number;
  readonly tail?: ProcessOutputTail;
}

const TAIL_LINES = 4;

function Row({ child, index, tail }: RowProps): React.JSX.Element {
  // The state layer already caps each stream at PROCESS_TAIL_CHARS_MAX, so
  // pulling the last `TAIL_LINES` non-blank lines is bounded work.
  const tailLines = processTailLines(tail).slice(-TAIL_LINES);
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dimColor>{index < 9 ? ` ${index + 1} ` : '   '}</Text>
        <Text color={childStatusColor(child.status)}>
          {childStatusMarker()}
        </Text>
        <Text>{child.agentName || child.toolName || child.executionId}</Text>
        {child.status ? <Text dimColor>{` ${child.status}`}</Text> : null}
        {child.elapsed ? <Text dimColor>{` · ${child.elapsed}`}</Text> : null}
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
  if (!slice) return null;
  if (subagents.length === 0 && activeProcesses.length === 0) return null;
  if (props.maxRows !== undefined && props.maxRows <= 0) return null;

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
          <Text bold dimColor>
            Subagents
          </Text>
          {subagents.map((child, i) => (
            <Row key={child.executionId} child={child} index={i} />
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
              tail={processOutput?.get(child.executionId)}
            />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
