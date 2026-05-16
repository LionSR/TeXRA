// Lists active subagents + processes for the currently-focused stream.
//
// One row per `ActiveChildInfo`. The leading numeric index is currently a
// visual cue only — the `1`–`9` jump shortcuts land in Phase 5 alongside
// the input-focus toggle.

import { Box, Text } from 'ink';

import type { ActiveChildInfo } from '@shared/schemas';

import { cliState } from '../state/cliState';
import { useSignal } from '../state/useSignal';

interface RowProps {
  readonly child: ActiveChildInfo;
  readonly index: number;
}

function statusColor(status: string | undefined): string | undefined {
  if (!status) return 'green';
  if (status === 'waiting' || status === 'idle') return 'yellow';
  if (status === 'error' || status === 'stopped') return 'red';
  return 'green';
}

function Row({ child, index }: RowProps): React.JSX.Element {
  return (
    <Box flexDirection="row">
      <Text dimColor>{index < 9 ? ` ${index + 1} ` : '   '}</Text>
      <Text color={statusColor(child.status)}>● </Text>
      <Text>{child.agentName || child.toolName || child.executionId}</Text>
      {child.status ? <Text dimColor>{` ${child.status}`}</Text> : null}
      {child.elapsed ? <Text dimColor>{` · ${child.elapsed}`}</Text> : null}
    </Box>
  );
}

export function SubagentList(): React.JSX.Element | null {
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  if (!slice) return null;
  const subagents = slice.activeSubagents;
  const processes = slice.activeProcesses;
  if (subagents.length === 0 && processes.length === 0) return null;

  let cursor = 0;
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {subagents.length > 0 ? (
        <Box flexDirection="column">
          <Text bold dimColor>
            Subagents
          </Text>
          {subagents.map((child) => (
            <Row key={child.executionId} child={child} index={cursor++} />
          ))}
        </Box>
      ) : null}
      {processes.length > 0 ? (
        <Box flexDirection="column" marginTop={subagents.length > 0 ? 1 : 0}>
          <Text bold dimColor>
            Processes
          </Text>
          {processes.map((child) => (
            <Row key={child.executionId} child={child} index={cursor++} />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
