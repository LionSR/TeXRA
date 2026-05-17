// Conversation pane for user and assistant transcript entries.
//
// Finalized entries are committed to ink's `<Static>` region so they survive
// re-renders and stay in scrollback. The in-flight entry (last one when the
// stream is still streaming) renders in a live `<Box>` above the input bar.
//
// Finalized assistant text goes through the ANSI markdown renderer
// (`render/Markdown.tsx`). Live assistant text stays plain so a growing
// response does not repeatedly parse a full Markdown document while the input
// bar is also accepting keystrokes.

import { Box, Static, Text } from 'ink';

import { STREAM_STATUS, type StreamStatus } from '@shared/schemas';

import { Markdown } from '../render/Markdown';
import { cliState, type ConversationEntry } from '../state/cliState';
import { useSignal } from '../state/useSignal';

function isAppending(status: StreamStatus | undefined): boolean {
  return (
    status === STREAM_STATUS.INITIALIZING ||
    status === STREAM_STATUS.RUNNING ||
    status === STREAM_STATUS.RESUMING
  );
}

function TranscriptEntry({
  entry,
  width,
}: {
  readonly entry: ConversationEntry;
  readonly width?: number;
}): React.JSX.Element {
  if (entry.role === 'user') {
    return (
      <Box marginBottom={1} paddingX={1}>
        <Text dimColor>› </Text>
        <Text>{entry.text}</Text>
      </Box>
    );
  }

  return (
    <Box marginBottom={1}>
      <Markdown content={entry.text} width={width} />
    </Box>
  );
}

function LiveTranscriptEntry({
  entry,
}: {
  readonly entry: ConversationEntry;
}): React.JSX.Element {
  return (
    <Box marginBottom={1}>
      <Text>{entry.text}</Text>
    </Box>
  );
}

export interface ConversationPaneProps {
  readonly width?: number;
}

export function ConversationPane(
  props: ConversationPaneProps = {},
): React.JSX.Element {
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const entries = slice?.entries ?? [];
  const streamIsAppending = isAppending(slice?.status);

  const finalized: ConversationEntry[] = [];
  let live: ConversationEntry | undefined;
  for (const entry of entries) {
    if (
      streamIsAppending &&
      entry.role === 'assistant' &&
      !entry.finalized &&
      entry === entries.at(-1)
    ) {
      live = entry;
    } else {
      finalized.push({ ...entry, finalized: true });
    }
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Static items={finalized}>
        {(entry) => (
          <TranscriptEntry key={entry.id} entry={entry} width={props.width} />
        )}
      </Static>
      {live ? <LiveTranscriptEntry entry={live} /> : null}
    </Box>
  );
}
