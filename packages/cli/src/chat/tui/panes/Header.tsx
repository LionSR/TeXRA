import { Box, Text } from 'ink';

import { cliState } from '../state/cliState';
import { useSignal } from '../state/useSignal';

function formatNumber(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(cost: number | undefined): string {
  if (cost === undefined) return '—';
  return `$${cost.toFixed(4)}`;
}

export function Header(): React.JSX.Element {
  const meta = useSignal(cliState.sessionMeta);
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;

  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Text>
          <Text bold>TeXRA</Text>
          <Text dimColor> · </Text>
          <Text>{meta.agent || '—'}</Text>
          <Text dimColor> · </Text>
          <Text>{meta.model || '—'}</Text>
        </Text>
        <Text dimColor>{slice?.description ?? meta.cwd}</Text>
      </Box>
      {slice?.usage ? (
        <Box>
          <Text dimColor>
            in {formatNumber(slice.usage.inputTokens)} · out{' '}
            {formatNumber(slice.usage.outputTokens)} · cost{' '}
            {formatCost(slice.usage.cost)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
