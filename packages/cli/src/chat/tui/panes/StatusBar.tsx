import { Box, Text } from 'ink';

import { STREAM_STATUS } from '@shared/schemas';

import { cliState, NO_BYPASS } from '../state/cliState';
import { useSignal } from '../state/useSignal';

function statusLabel(status: string | undefined): string {
  switch (status) {
    case STREAM_STATUS.INITIALIZING:
      return 'starting…';
    case STREAM_STATUS.RUNNING:
      return 'running';
    case STREAM_STATUS.WAITING:
      return 'idle';
    case STREAM_STATUS.STOPPED:
      return 'stopped';
    case STREAM_STATUS.READY:
      return 'ready';
    default:
      return status ?? '—';
  }
}

export function StatusBar(): React.JSX.Element {
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const queued = slice?.queuedFollowUps ?? 0;
  const bypass = slice?.bypass ?? NO_BYPASS;

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <Text dimColor>{statusLabel(slice?.status)}</Text>
        {bypass.superYolo ? (
          <Text color="red" bold>
            {'  YOLO'}
          </Text>
        ) : null}
        {bypass.toolEdit ? (
          <Text color="yellow" bold>
            {'  BYPASS'}
          </Text>
        ) : null}
      </Box>
      {queued > 0 ? <Text dimColor>queued: {queued}</Text> : null}
    </Box>
  );
}
