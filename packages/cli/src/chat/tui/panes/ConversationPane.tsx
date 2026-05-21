// Conversation pane for user and assistant transcript entries.
//
// Finalized entries render as a viewport-limited tail inside the Ink tree.
// The in-flight entry (last one when the stream is still streaming) renders
// in a live `<Box>` above the input bar.
//
// Finalized assistant text goes through the ANSI markdown renderer
// (`render/Markdown.tsx`). Live assistant text stays plain so a growing
// response does not repeatedly parse a full Markdown document while the input
// bar is also accepting keystrokes.

import { Box, Text } from 'ink';

import { Markdown } from '../render/Markdown';
import { renderAnsiMarkdown } from '../render/ansiMarkdown';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import {
  cliState,
  registerCliStateResetHook,
  type ConversationEntry,
} from '../state/cliState';
import { completedProcessDisplayLines } from '../state/completedProcessTranscript';
import { useSignal } from '../state/useSignal';
import { ToolUseRow } from './ToolUseRow';
import { toolUseDisplayLines } from './toolRenderers';
import { splitTranscriptEntries } from './transcriptEntries';

export { splitTranscriptEntries } from './transcriptEntries';

function ProcessEntryRow({
  process,
}: {
  readonly process: NonNullable<ConversationEntry['process']>;
}): React.JSX.Element {
  const color = process.isError ? 'red' : 'green';
  const [, ...tailLines] = completedProcessDisplayLines(process);
  return (
    <Box marginBottom={1} paddingX={1} flexDirection="column">
      <Box>
        <Text color={color}>● </Text>
        <Text>{process.title}</Text>
        {process.status ? <Text dimColor>{` · ${process.status}`}</Text> : null}
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

function TranscriptEntry({
  entry,
  width,
}: {
  readonly entry: ConversationEntry;
  readonly width?: number;
}): React.JSX.Element {
  switch (entry.role) {
    case 'user':
      return (
        <Box paddingX={1}>
          <Text dimColor>› </Text>
          <Text>{entry.text}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box paddingX={1}>
          <Text color="red">! </Text>
          <Text color="red">{entry.text}</Text>
        </Box>
      );
    case 'tool':
      if (entry.toolUse) return <ToolUseRow toolUse={entry.toolUse} />;
      break;
    case 'process':
      if (entry.process) return <ProcessEntryRow process={entry.process} />;
      break;
  }
  return (
    <Box marginBottom={1}>
      <Markdown content={entry.text} width={width} />
    </Box>
  );
}

// Bounds the live-region row count. Ink redraws the live region on every
// streaming delta; if it overflows the viewport the cursor-up rewrite
// overshoots and clobbers rows already in the alternate screen.
const LIVE_TAIL_ROWS = 12;
const NEWLINE_CHAR_CODE = 10;
const DEFAULT_TRANSCRIPT_ROWS = 24;
const MIN_PENDING_ROWS = 1;
const HIDDEN_MARKER_ROWS = 1;

function estimateWrappedRows(text: string, width: number): number {
  const cols = Math.max(1, width);
  const lines = text.length > 0 ? text.split('\n') : [''];
  return lines.reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(line.length / cols)),
    0,
  );
}

export function estimateTranscriptEntryRows(
  entry: ConversationEntry,
  width = 80,
): number {
  if (entry.role === 'tool' && entry.toolUse) {
    return toolUseDisplayLines(entry.toolUse).length + 1;
  }
  if (entry.role === 'process' && entry.process) {
    return Math.max(1, completedProcessDisplayLines(entry.process).length) + 1;
  }
  if (entry.role === 'assistant') {
    const rendered = renderAnsiMarkdown(entry.text, { width });
    return Math.max(1, rendered.split('\n').length) + 1;
  }
  // User / error rows render without a trailing margin (compact mode) so
  // chat-heavy sessions don't burn half the viewport on blank gaps. Keep
  // the estimate in sync with the rendered height to avoid wasted budget.
  if (entry.role === 'user' || entry.role === 'error') {
    return estimateWrappedRows(entry.text, width);
  }

  return estimateWrappedRows(entry.text, width) + 1;
}

function estimatePendingEntryRows(
  entry: ConversationEntry,
  width = 80,
): number {
  if (entry.role === 'assistant') {
    return Math.min(LIVE_TAIL_ROWS, estimateWrappedRows(entry.text, width));
  }

  return estimateTranscriptEntryRows(entry, width);
}

function selectEntriesForViewport(
  entries: readonly ConversationEntry[],
  maxRows: number,
  width = 80,
  estimateRows: (entry: ConversationEntry, width: number) => number,
): {
  entries: readonly ConversationEntry[];
  hiddenCount: number;
  usedRows: number;
} {
  if (!Number.isFinite(maxRows) || maxRows <= 0) {
    return { entries: [], hiddenCount: entries.length, usedRows: 0 };
  }

  const selected: ConversationEntry[] = [];
  let usedRows = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    const entryRows = estimateRows(entry, width);
    const markerRows = index > 0 ? HIDDEN_MARKER_ROWS : 0;
    const fits = usedRows + entryRows + markerRows <= maxRows;
    if (!fits) break;
    selected.unshift(entry);
    usedRows += entryRows;
  }

  const hiddenCount = entries.length - selected.length;
  if (selected.length === 0 && hiddenCount > 0) {
    return { entries: [], hiddenCount, usedRows: HIDDEN_MARKER_ROWS };
  }

  return {
    entries: selected,
    hiddenCount,
    usedRows: usedRows + (hiddenCount > 0 ? HIDDEN_MARKER_ROWS : 0),
  };
}

export function selectFinalizedEntriesForViewport(
  entries: readonly ConversationEntry[],
  maxRows: number,
  width = 80,
): {
  entries: readonly ConversationEntry[];
  hiddenCount: number;
  usedRows: number;
} {
  return selectEntriesForViewport(
    entries,
    maxRows,
    width,
    estimateTranscriptEntryRows,
  );
}

export function selectPendingEntriesForViewport(
  entries: readonly ConversationEntry[],
  maxRows: number,
  width = 80,
): {
  entries: readonly ConversationEntry[];
  hiddenCount: number;
  usedRows: number;
} {
  return selectEntriesForViewport(
    entries,
    maxRows,
    width,
    estimatePendingEntryRows,
  );
}

export function selectConversationEntriesForViewport({
  finalized,
  maxRows,
  pending,
  width,
}: {
  readonly finalized: readonly ConversationEntry[];
  readonly maxRows: number;
  readonly pending: readonly ConversationEntry[];
  readonly width?: number;
}): {
  readonly finalizedRows: number;
  readonly pendingRows: number;
  readonly visibleFinalized: ReturnType<
    typeof selectFinalizedEntriesForViewport
  >;
  readonly visiblePending: ReturnType<typeof selectPendingEntriesForViewport>;
} {
  const reserveFinalizedMarker =
    pending.length > 0 && finalized.length > 0 && maxRows > HIDDEN_MARKER_ROWS;
  const pendingBudget = Math.max(
    MIN_PENDING_ROWS,
    maxRows - (reserveFinalizedMarker ? HIDDEN_MARKER_ROWS : 0),
  );
  const visiblePending = selectPendingEntriesForViewport(
    pending,
    pendingBudget,
    width,
  );
  const pendingRows =
    pending.length > 0
      ? Math.max(MIN_PENDING_ROWS, visiblePending.usedRows)
      : 0;
  const finalizedRows = Math.max(0, maxRows - pendingRows);
  const visibleFinalized = selectFinalizedEntriesForViewport(
    finalized,
    finalizedRows,
    width,
  );

  return {
    finalizedRows,
    pendingRows,
    visibleFinalized,
    visiblePending,
  };
}

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
  readonly maxRows?: number;
}

export function ConversationPane(
  props: ConversationPaneProps = {},
): React.JSX.Element {
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const entries = slice?.entries ?? [];
  const { finalized, pending } = splitTranscriptEntries(entries, slice?.status);
  const maxRows = props.maxRows ?? DEFAULT_TRANSCRIPT_ROWS;
  const { pendingRows, visibleFinalized, visiblePending } =
    selectConversationEntriesForViewport({
      finalized,
      maxRows,
      pending,
      width: props.width,
    });

  return (
    <Box flexDirection="column" height={maxRows} overflowY="hidden">
      <Box
        flexDirection="column"
        height={visibleFinalized.usedRows}
        overflowY="hidden"
      >
        {visibleFinalized.hiddenCount > 0 ? (
          <Text dimColor>
            {`⋯ ${visibleFinalized.hiddenCount} earlier ${
              visibleFinalized.hiddenCount === 1 ? 'entry' : 'entries'
            } hidden`}
          </Text>
        ) : null}
        {visibleFinalized.entries.map((entry) => (
          <TranscriptEntry key={entry.id} entry={entry} width={props.width} />
        ))}
      </Box>
      {/* `pending` interleaves the in-flight assistant entry with tool
       *  rows in stream order — rendering them as separate buckets would
       *  flip the visible order when the model emits text before a tool
       *  call. The explicit height keeps the input bar pinned and prevents
       *  tool bursts from stealing rows reserved for the footer chrome. */}
      <Box flexDirection="column" height={pendingRows} overflowY="hidden">
        {visiblePending.hiddenCount > 0 ? (
          <Text dimColor>
            {`⋯ ${visiblePending.hiddenCount} live ${
              visiblePending.hiddenCount === 1 ? 'entry' : 'entries'
            } hidden`}
          </Text>
        ) : null}
        {visiblePending.entries.map((entry) => {
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
