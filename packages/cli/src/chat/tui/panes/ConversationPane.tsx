// Conversation pane — Phase 1 renders MODEL_RESPONSE entries only.
//
// Finalized entries are committed to ink's `<Static>` region so they survive
// re-renders and stay in scrollback. The in-flight entry (last one when the
// stream is still streaming) renders in a live `<Box>` above the input bar.
//
// Phase 3 routes entry text through the ANSI markdown renderer
// (`render/Markdown.tsx`); tool cards and multi-agent stripes land in later
// phases.

import { Box, Static } from 'ink';

import { Markdown } from '../render/Markdown';
import { cliState, type ConversationEntry } from '../state/cliState';
import { useSignal } from '../state/useSignal';

function isStreaming(entry: ConversationEntry): boolean {
  return !entry.finalized;
}

export function ConversationPane(): React.JSX.Element {
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const entries = slice?.entries ?? [];

  const finalized: ConversationEntry[] = [];
  let live: ConversationEntry | undefined;
  for (const entry of entries) {
    if (isStreaming(entry) && entry === entries.at(-1)) {
      live = entry;
    } else {
      finalized.push({ ...entry, finalized: true });
    }
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Static items={finalized}>
        {(entry) => (
          <Box key={entry.id} marginBottom={1}>
            <Markdown content={entry.text} />
          </Box>
        )}
      </Static>
      {live ? (
        <Box marginBottom={1}>
          <Markdown content={live.text} />
        </Box>
      ) : null}
    </Box>
  );
}
