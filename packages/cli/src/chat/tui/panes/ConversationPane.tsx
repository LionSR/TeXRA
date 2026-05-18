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
import { wrapAnsiToWidth } from '../render/ansiWrap';
import {
  cliState,
  registerCliStateResetHook,
  type ConversationEntry,
} from '../state/cliState';
import { completedProcessDisplayLines } from '../state/completedProcessTranscript';
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

  if (entry.role === 'process' && entry.process) {
    const process = entry.process;
    const color = process.isError ? 'red' : 'green';
    const [, ...tailLines] = completedProcessDisplayLines(process);
    return (
      <Box marginBottom={1} paddingX={1} flexDirection="column">
        <Box>
          <Text color={color}>● </Text>
          <Text>{process.title}</Text>
          {process.status ? (
            <Text dimColor>{` · ${process.status}`}</Text>
          ) : null}
          {process.elapsed ? (
            <Text dimColor>{` · ${process.elapsed}`}</Text>
          ) : null}
          {process.isError ? <Text color="red"> · error</Text> : null}
        </Box>
        {process.tailLines.length > 0 ? (
          <Box marginLeft={2} flexDirection="column">
            {tailLines.map((line, index) => (
              <Text
                key={index}
                color={process.isError ? 'red' : undefined}
                dimColor={!process.isError}
              >
                {line}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box marginBottom={1}>
      <Markdown content={entry.text} width={width} />
    </Box>
  );
}

// Bounds the live-region row count. Ink redraws the live region on every
// streaming delta; if it overflows the viewport the cursor-up rewrite
// overshoots and clobbers Static rows already in scrollback.
const LIVE_TAIL_ROWS = 12;
const NEWLINE_CHAR_CODE = 10;

// Incremental newline count keyed by entry id. The live text grows
// monotonically per delta; without a cache we'd rescan the full prefix
// every frame and reintroduce the O(text²) cumulative cost the wrap
// budget is here to avoid. Cleared per session in `resetCliState` via
// `registerCliStateResetHook` below.
const newlineCountCache = new Map<
  string,
  { length: number; newlines: number }
>();
registerCliStateResetHook(() => newlineCountCache.clear());

function countNewlinesUpTo(
  entryId: string,
  text: string,
  upTo: number,
): number {
  const cached = newlineCountCache.get(entryId);
  // Append-only invariant: if `upTo` ≥ cached.length and the cached
  // prefix is still a prefix of `text`, we can extend. Otherwise (text
  // shrank or rewrote earlier chars) recount from scratch.
  const canExtend =
    cached !== undefined &&
    upTo >= cached.length &&
    cached.length <= text.length;
  let count = canExtend ? cached.newlines : 0;
  const start = canExtend ? cached.length : 0;
  for (let i = start; i < upTo; i += 1) {
    if (text.charCodeAt(i) === NEWLINE_CHAR_CODE) count += 1;
  }
  newlineCountCache.set(entryId, { length: upTo, newlines: count });
  return count;
}

function LiveTranscriptEntry({
  entry,
  width,
}: {
  readonly entry: ConversationEntry;
  readonly width?: number;
}): React.JSX.Element {
  // Cap by *wrapped* rows, not by `\n` count — an LLM often streams one
  // long paragraph with no hard newlines, which Ink would still wrap to
  // many terminal rows. Slice the raw text down to a tail-sized window
  // before wrapping so per-delta wrap work stays bounded; otherwise the
  // whole growing buffer is re-wrapped on every keystroke (O(text²)
  // over the response). Live text is plain (see file header), so
  // slicing mid-string can't corrupt an ANSI escape.
  const cols = width ?? 80;
  const wrapBudget = cols * LIVE_TAIL_ROWS * 2;
  const slicedChars = Math.max(0, entry.text.length - wrapBudget);
  const candidate =
    slicedChars > 0 ? entry.text.slice(slicedChars) : entry.text;
  const rows = wrapAnsiToWidth(candidate, cols).split('\n');
  // Estimate rows lost to the raw-char slice: each hard newline counts
  // one row, remaining chars wrap by width. Approximate (exact would
  // need wrapping the full buffer).
  const slicedNewlines = countNewlinesUpTo(entry.id, entry.text, slicedChars);
  const slicedRows =
    slicedNewlines + Math.ceil((slicedChars - slicedNewlines) / cols);
  const needsHint = rows.length + slicedRows > LIVE_TAIL_ROWS;
  const tailLimit = needsHint ? LIVE_TAIL_ROWS - 1 : LIVE_TAIL_ROWS;
  const tail = rows.slice(-tailLimit);
  const hiddenRows = rows.length - tail.length + slicedRows;
  return (
    <Box flexDirection="column">
      {hiddenRows > 0 ? (
        <Text dimColor>
          ⋯ {hiddenRows} earlier row{hiddenRows === 1 ? '' : 's'} hidden while
          streaming
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
            return (
              <LiveTranscriptEntry
                key={entry.id}
                entry={entry}
                width={props.width}
              />
            );
          }
          return null;
        })}
      </Box>
    </Box>
  );
}
