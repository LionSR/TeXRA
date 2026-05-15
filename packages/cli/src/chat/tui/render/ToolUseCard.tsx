// Common chrome for tool-use entries per PRD § Tool rendering.
//
// Phase 2 ships the base card — a header row (tool · target · status ·
// timing) plus a compact body. Per-tool rich bodies (Bash live-tail,
// Edit diff) register against this base in later iterations; for now the
// fallback compact body renders whatever `summary`/`input` text the
// normalized `ToolUseLog` provides.

import { Box, Text } from 'ink';

export interface ToolUseCardProps {
  readonly toolName: string;
  readonly target?: string;
  readonly status?: string;
  readonly elapsedMs?: number;
  readonly summary?: string;
  readonly error?: string;
}

function statusColor(
  status: string | undefined,
): 'green' | 'yellow' | 'red' | undefined {
  if (!status) return undefined;
  if (status === 'success' || status === 'completed') return 'green';
  if (status === 'failure' || status === 'error') return 'red';
  return 'yellow';
}

function formatElapsed(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ToolUseCard(props: ToolUseCardProps): React.JSX.Element {
  const elapsed = formatElapsed(props.elapsedMs);
  const color = statusColor(props.status);
  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Text>
          <Text bold>{props.toolName}</Text>
          {props.target ? (
            <>
              <Text dimColor> · </Text>
              <Text>{props.target}</Text>
            </>
          ) : null}
        </Text>
        <Text dimColor>
          {props.status ? <Text color={color}>{props.status}</Text> : null}
          {elapsed ? <> · {elapsed}</> : null}
        </Text>
      </Box>
      {props.summary ? <Text dimColor>{props.summary}</Text> : null}
      {props.error ? <Text color="red">{props.error}</Text> : null}
    </Box>
  );
}
