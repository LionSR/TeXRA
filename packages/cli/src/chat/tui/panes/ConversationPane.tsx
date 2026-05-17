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

  if (entry.role === 'error') {
    return (
      <Box marginBottom={1} paddingX={1}>
        <Text color="red">! </Text>
        <Text color="red">{entry.text}</Text>
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

export function splitTranscriptEntries(
  entries: readonly ConversationEntry[],
  status: StreamStatus | undefined,
): {
  readonly finalized: ConversationEntry[];
  readonly live: ConversationEntry | undefined;
} {
  const streamIsAppending = isAppending(status);
  let live: ConversationEntry | undefined;
  if (streamIsAppending) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.role !== 'assistant' || entry.finalized) continue;
      live = entry;
      break;
    }
  }
  const finalized = entries
    .filter((entry) => entry !== live)
    .map((entry) => ({ ...entry, finalized: true }));

  return { finalized, live };
}

export function ConversationPane(
  props: ConversationPaneProps = {},
): React.JSX.Element {
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const entries = slice?.entries ?? [];
  const { finalized, live } = splitTranscriptEntries(entries, slice?.status);

  return (
    <Box flexDirection="column">
      <Static items={finalized}>
        {(entry) => (
          <TranscriptEntry key={entry.id} entry={entry} width={props.width} />
        )}
      </Static>
      {live ? <LiveTranscriptEntry entry={live} /> : null}
    </Box>
  );
}
