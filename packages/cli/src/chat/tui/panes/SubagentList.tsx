// Lists active subagents + processes for the currently-focused stream and
// tails the live stdout/stderr per process so the user can see what each
// shell call is doing.
//
// The leading numeric index is currently a visual cue only — the `1`–`9`
// jump shortcuts land in Phase 5 alongside the input-focus toggle.

import { Box, Text } from 'ink';

import type { ActiveChildInfo } from '@shared/schemas';

import { cliState, type ProcessOutputTail } from '../state/cliState';
import { useSignal } from '../state/useSignal';

interface RowProps {
  readonly child: ActiveChildInfo;
  readonly index: number;
  readonly tail?: ProcessOutputTail;
}

const TAIL_LINES = 4;

function statusColor(status: string | undefined): string | undefined {
  if (!status) return 'green';
  if (status === 'waiting' || status === 'idle') return 'yellow';
  if (status === 'error' || status === 'stopped') return 'red';
  return 'green';
}

/** Pull the last `TAIL_LINES` non-blank lines from the combined std streams.
 *  The state layer already caps each stream at PROCESS_TAIL_CHARS_MAX, so
 *  this is bounded work. */
function lastLines(tail: ProcessOutputTail | undefined): string[] {
  if (!tail) return [];
  const combined = `${tail.stdout}\n${tail.stderr}`;
  const lines = combined.split('\n');
  const trimmed: string[] = [];
  for (let i = lines.length - 1; i >= 0 && trimmed.length < TAIL_LINES; i--) {
    const line = lines[i]?.trimEnd();
    if (line) trimmed.unshift(line);
  }
  return trimmed;
}

function Row({ child, index, tail }: RowProps): React.JSX.Element {
  const tailLines = lastLines(tail);
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dimColor>{index < 9 ? ` ${index + 1} ` : '   '}</Text>
        <Text color={statusColor(child.status)}>● </Text>
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

export function SubagentList(): React.JSX.Element | null {
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  if (!slice) return null;
  const { activeSubagents, activeProcesses, processOutput } = slice;
  if (activeSubagents.length === 0 && activeProcesses.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {activeSubagents.length > 0 ? (
        <Box flexDirection="column">
          <Text bold dimColor>
            Subagents
          </Text>
          {activeSubagents.map((child, i) => (
            <Row key={child.executionId} child={child} index={i} />
          ))}
        </Box>
      ) : null}
      {activeProcesses.length > 0 ? (
        <Box
          flexDirection="column"
          marginTop={activeSubagents.length > 0 ? 1 : 0}
        >
          <Text bold dimColor>
            Processes
          </Text>
          {activeProcesses.map((child, i) => (
            <Row
              key={child.executionId}
              child={child}
              index={activeSubagents.length + i}
              tail={processOutput.get(child.executionId)}
            />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
