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

import { Markdown } from '../render/Markdown';
import { cliState, type ConversationEntry } from '../state/cliState';
import { useSignal } from '../state/useSignal';
import { ToolUseRow } from './ToolUseRow';
import { splitTranscriptEntries } from './transcriptEntries';

export { splitTranscriptEntries } from './transcriptEntries';

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

  if (entry.role === 'tool' && entry.toolUse) {
    return <ToolUseRow toolUse={entry.toolUse} />;
  }

  return (
    <Box marginBottom={1}>
      <Markdown content={entry.text} width={width} />
    </Box>
  );
}

// Cap the streaming live region to a short tail. Ink redraws the live
// region on every text delta by moving the cursor up and rewriting the
// rows; if the live region grows taller than the terminal viewport the
// cursor-up overshoots and clobbers Static items that have already been
// pushed into scrollback (truncating earlier turns when the user scrolls
// back). The full content is preserved — the assistant entry transitions
// into Ink's <Static> the moment it finalizes, which writes it to
// scrollback in one shot. Keep this number small; it bounds the
// scrollback damage during long streaming responses.
const LIVE_TAIL_LINES = 12;

function LiveTranscriptEntry({
  entry,
}: {
  readonly entry: ConversationEntry;
}): React.JSX.Element {
  const lines = entry.text.split('\n');
  const hiddenLines = Math.max(0, lines.length - LIVE_TAIL_LINES);
  const tail = hiddenLines > 0 ? lines.slice(-LIVE_TAIL_LINES) : lines;
  return (
    <Box flexDirection="column">
      {hiddenLines > 0 ? (
        <Text dimColor>
          ⋯ {hiddenLines} earlier line{hiddenLines === 1 ? '' : 's'} hidden
          while streaming
        </Text>
      ) : null}
      <Text>{tail.join('\n')}</Text>
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
  const { finalized, pending } = splitTranscriptEntries(entries, slice?.status);

  return (
    <Box flexDirection="column">
      <Static items={finalized}>
        {(entry) => (
          <TranscriptEntry key={entry.id} entry={entry} width={props.width} />
        )}
      </Static>
      {/* `pending` interleaves the in-flight assistant entry with tool
       *  rows in stream order — rendering them as separate buckets would
       *  flip the visible order when the model emits text before a tool
       *  call. <Static> can't carry these because they still mutate
       *  (assistant text streaming, tool dot transitioning). The
       *  minHeight=1 keeps the input bar pinned when the bucket is
       *  empty. */}
      <Box flexDirection="column" minHeight={1}>
        {pending.map((entry) => {
          if (entry.role === 'tool' && entry.toolUse) {
            return <ToolUseRow key={entry.id} toolUse={entry.toolUse} />;
          }
          if (entry.role === 'assistant') {
            return <LiveTranscriptEntry key={entry.id} entry={entry} />;
          }
          return null;
        })}
      </Box>
    </Box>
  );
}
