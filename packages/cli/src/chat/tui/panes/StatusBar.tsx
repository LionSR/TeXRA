import { Box, Text } from 'ink';
import { Badge } from '@inkjs/ui';

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
  const sessionMeta = useSignal(cliState.sessionMeta);
  const pendingExitHint = useSignal(cliState.pendingExitHint);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const queued = slice?.queuedFollowUps ?? 0;
  const bypass = slice?.bypass ?? NO_BYPASS;
  const agent = sessionMeta.agent || 'chat';
  const model = sessionMeta.model || '—';

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box gap={1}>
        <Text color="cyan">◆</Text>
        <Text>
          {agent} · {model}
        </Text>
        <Text dimColor>·</Text>
        {pendingExitHint ? (
          <Text color="yellow">Press Ctrl-C again to exit</Text>
        ) : (
          <Text dimColor>{statusLabel(slice?.status)}</Text>
        )}
        {bypass.superYolo ? <Badge color="red">YOLO</Badge> : null}
        {bypass.toolEdit ? <Badge color="yellow">BYPASS</Badge> : null}
      </Box>
      {queued > 0 ? <Text dimColor>queued: {queued}</Text> : null}
    </Box>
  );
}
