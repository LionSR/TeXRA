// Lists active subagents + processes for the currently-focused stream and
// tails the live stdout/stderr per process so the user can see what each
// shell call is doing.
//
// The leading numeric index is currently a visual cue only.

import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

import type { ActiveChildInfo } from '@shared/schemas';

import { visibleSubagentRows } from '../state/childControls';
import { cliState, type ProcessOutputTail } from '../state/cliState';
import { useSignal } from '../state/useSignal';
import {
  childStatusColor,
  childStatusMarker,
  childStatusPulses,
} from './SubagentListDisplay';

interface RowProps {
  readonly child: ActiveChildInfo;
  readonly index: number;
  readonly pulseOn: boolean;
  readonly tail?: ProcessOutputTail;
}

const TAIL_LINES = 4;
const PULSE_INTERVAL_MS = 700;

/** Pull the last `TAIL_LINES` non-blank lines from the combined std streams.
 *  The state layer already caps each stream at PROCESS_TAIL_CHARS_MAX, so
 *  this is bounded work. */
function lastLines(tail: ProcessOutputTail | undefined): string[] {
  if (!tail) return [];
  const nonBlank = `${tail.stdout}\n${tail.stderr}`
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return nonBlank.slice(-TAIL_LINES);
}

function usePulse(enabled: boolean): boolean {
  const [pulseOn, setPulseOn] = useState(true);
  useEffect(() => {
    if (!enabled) {
      setPulseOn(true);
      return;
    }
    const timer = setInterval(
      () => setPulseOn((value) => !value),
      PULSE_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [enabled]);
  return pulseOn;
}

function Row({ child, index, pulseOn, tail }: RowProps): React.JSX.Element {
  const tailLines = lastLines(tail);
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dimColor>{index < 9 ? ` ${index + 1} ` : '   '}</Text>
        <Text color={childStatusColor(child.status)}>
          {childStatusMarker(child.status, pulseOn)}
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
  const pulseOn = usePulse(
    [...subagents, ...activeProcesses].some((child) =>
      childStatusPulses(child.status),
    ),
  );
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
            <Row
              key={child.executionId}
              child={child}
              index={i}
              pulseOn={pulseOn}
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
              pulseOn={pulseOn}
              tail={processOutput?.get(child.executionId)}
            />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
