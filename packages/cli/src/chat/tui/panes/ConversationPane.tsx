// Conversation pane for session metadata and user/assistant transcript entries.
//
// Finalized entries render through Ink `<Static>` so the terminal owns the
// transcript scrollback. The bounded pane below is only for in-flight entries
// that may still change.
//
// Finalized assistant text goes through the ANSI markdown renderer
// (`render/Markdown.tsx`). Live assistant text stays plain so a growing
// response does not repeatedly parse a full Markdown document while the input
// bar is also accepting keystrokes.

import os from 'node:os';
import path from 'node:path';

import { useEffect, useState } from 'react';
import { Box, Static, Text } from 'ink';

import { Markdown } from '../render/Markdown';
import { renderAnsiMarkdown } from '../render/ansiMarkdown';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import {
  cliState,
  type ConversationEntry,
  type SessionMeta,
} from '../state/cliState';
import { completedProcessDisplayLines } from '../state/completedProcessTranscript';
import { useSignal } from '../state/useSignal';
import { ToolUseRow } from './ToolUseRow';
import { toolUseDisplayLines } from './toolRenderers';
import { splitTranscriptEntries } from './transcriptEntries';
import { shortCliApiMode } from '../../../runtime/apiAccessMode';

export { splitTranscriptEntries } from './transcriptEntries';

export type StaticTranscriptItem =
  | {
      readonly id: string;
      readonly kind: 'header';
      readonly meta: SessionMeta;
    }
  | {
      readonly id: string;
      readonly kind: 'entry';
      readonly entry: ConversationEntry;
    };

function shortenCwd(cwd: string): string {
  const home = os.homedir();
  if (cwd === home) return '~';
  const sep = path.sep;
  if (cwd.startsWith(`${home}${sep}`)) {
    return `~${sep}${cwd.slice(home.length + sep.length)}`;
  }
  return cwd;
}

function SessionHeaderBlock({
  meta,
  width,
}: {
  readonly meta: SessionMeta;
  readonly width?: number;
}): React.JSX.Element {
  const columns = Math.max(1, Math.floor(width ?? 80));
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{'─'.repeat(columns)}</Text>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        <Box gap={2}>
          <Text bold color="cyan">
            TeXRA
          </Text>
          <Text dimColor>v{meta.version}</Text>
          <Text dimColor>{shortCliApiMode(meta.apiMode)}</Text>
        </Box>
        <Box>
          <Text wrap="truncate-end">
            agent: {meta.agent || 'chat'} · model: {meta.model || '—'}
          </Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {shortenCwd(meta.cwd)}
        </Text>
      </Box>
    </Box>
  );
}

function staticEntryId(streamId: string, entry: ConversationEntry): string {
  return `${streamId}:${entry.id}`;
}

export function appendStaticTranscriptItems({
  activeStreamId,
  currentItems,
  entries,
  meta,
}: {
  readonly activeStreamId: string | undefined;
  readonly currentItems: readonly StaticTranscriptItem[];
  readonly entries: readonly ConversationEntry[];
  readonly meta: SessionMeta;
}): readonly StaticTranscriptItem[] {
  const nextItems: StaticTranscriptItem[] = [...currentItems];
  const seen = new Set(nextItems.map((item) => item.id));
  const headerId = 'session-header';
  if (!seen.has(headerId)) {
    nextItems.push({ id: headerId, kind: 'header', meta });
    seen.add(headerId);
  }
  if (!activeStreamId) return nextItems;

  for (const entry of entries) {
    if (!entry.finalized) continue;
    const id = staticEntryId(activeStreamId, entry);
    if (seen.has(id)) continue;
    nextItems.push({ id, kind: 'entry', entry });
    seen.add(id);
  }
  return nextItems;
}

export function StaticConversationTranscript({
  width,
}: {
  readonly width?: number;
}): React.JSX.Element {
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const sessionMeta = useSignal(cliState.sessionMeta);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const entries = slice?.entries ?? [];
  const [items, setItems] = useState<readonly StaticTranscriptItem[]>([]);

  useEffect(() => {
    if (streams.size === 0 && activeStreamId === undefined) {
      setItems([]);
      return;
    }
    setItems((currentItems) =>
      appendStaticTranscriptItems({
        activeStreamId,
        currentItems,
        entries,
        meta: sessionMeta,
      }),
    );
  }, [activeStreamId, entries, sessionMeta, streams.size]);

  return (
    <Static items={[...items]}>
      {(item) => (
        <Box key={item.id} flexDirection="column">
          {item.kind === 'header' ? (
            <SessionHeaderBlock meta={item.meta} width={width} />
          ) : (
            <TranscriptEntry entry={item.entry} width={width} />
          )}
        </Box>
      )}
    </Static>
  );
}

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
  maxRows,
  width,
}: {
  readonly entry: ConversationEntry;
  readonly maxRows?: number;
  readonly width?: number;
}): React.JSX.Element {
  if (maxRows !== undefined) {
    return (
      <BoundedTranscriptEntry entry={entry} maxRows={maxRows} width={width} />
    );
  }

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

function boundedLines(
  lines: readonly string[],
  maxRows: number,
): readonly string[] {
  return lines.slice(-Math.max(1, maxRows));
}

function BoundedTranscriptEntry({
  entry,
  maxRows,
  width,
}: {
  readonly entry: ConversationEntry;
  readonly maxRows: number;
  readonly width?: number;
}): React.JSX.Element {
  const rows = Math.max(1, maxRows);
  if (entry.role === 'assistant') {
    const rendered = renderAnsiMarkdown(entry.text, { width });
    return (
      <Box flexDirection="column">
        <Text>{boundedLines(rendered.split('\n'), rows).join('\n')}</Text>
      </Box>
    );
  }
  if (entry.role === 'tool' && entry.toolUse) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          {boundedLines(toolUseDisplayLines(entry.toolUse), rows).join('\n')}
        </Text>
      </Box>
    );
  }
  if (entry.role === 'process' && entry.process) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          {boundedLines(completedProcessDisplayLines(entry.process), rows).join(
            '\n',
          )}
        </Text>
      </Box>
    );
  }

  const prefix = entry.role === 'error' ? '! ' : '› ';
  const color = entry.role === 'error' ? 'red' : undefined;
  const cols = Math.max(1, (width ?? 80) - prefix.length - 2);
  const lines = wrapAnsiToWidth(entry.text, cols).split('\n');
  return (
    <Box paddingX={1}>
      <Text color={color}>
        {boundedLines(lines, rows)
          .map((line, index) => `${index === 0 ? prefix : '  '}${line}`)
          .join('\n')}
      </Text>
    </Box>
  );
}

const DEFAULT_TRANSCRIPT_ROWS = 24;
const MIN_PENDING_ROWS = 1;

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
  // chat-heavy sessions don't burn half the viewport on blank gaps. Their
  // box uses `paddingX={1}` (2 cols) and a 2-col prefix (`› ` / `! `), so
  // long text wraps to `width - 4` — keep the estimate in sync.
  if (entry.role === 'user' || entry.role === 'error') {
    return estimateWrappedRows(entry.text, Math.max(1, width - 4));
  }

  return estimateWrappedRows(entry.text, width) + 1;
}

function estimatePendingEntryRows(
  entry: ConversationEntry,
  width = 80,
): number {
  if (entry.role === 'assistant') {
    return estimateWrappedRows(entry.text, width);
  }

  return estimateTranscriptEntryRows(entry, width);
}

interface PendingEntrySelection {
  readonly entries: readonly ConversationEntry[];
  readonly hiddenCount: number;
  readonly rowLimits: ReadonlyMap<string, number>;
  readonly usedRows: number;
}

// Pick the newest live entries that fit in `maxRows`. Finalized entries do
// not pass through this path; they are printed once by `<Static>` so ordinary
// terminal scrollback is the source of truth for the conversation history.
function selectLiveEntriesForViewport(
  entries: readonly ConversationEntry[],
  maxRows: number,
  width: number,
): PendingEntrySelection {
  if (!Number.isFinite(maxRows) || maxRows <= 0) {
    return {
      entries: [],
      hiddenCount: entries.length,
      rowLimits: new Map(),
      usedRows: 0,
    };
  }

  const selected: ConversationEntry[] = [];
  const rowLimits = new Map<string, number>();
  let hiddenCount = 0;
  let usedRows = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    const entryRows = estimatePendingEntryRows(entry, width);
    const markerRows = index > 0 ? 1 : 0;
    const availableForEntries = maxRows - markerRows;
    if (availableForEntries <= 0) {
      hiddenCount = index + 1;
      usedRows = markerRows;
      break;
    }
    if (usedRows + entryRows > availableForEntries) {
      if (
        selected.length === 0 &&
        (entry.role === 'assistant' || entry.role === 'tool')
      ) {
        selected.unshift(entry);
        rowLimits.set(entry.id, availableForEntries);
        usedRows = availableForEntries;
        hiddenCount = index;
      } else {
        hiddenCount = index + 1;
      }
      if (hiddenCount > 0) usedRows += 1;
      break;
    }
    selected.unshift(entry);
    usedRows += entryRows;
  }
  return { entries: selected, hiddenCount, rowLimits, usedRows };
}

export function selectPendingEntriesForViewport(
  entries: readonly ConversationEntry[],
  maxRows: number,
  width = 80,
): PendingEntrySelection {
  return selectLiveEntriesForViewport(entries, maxRows, width);
}

function LiveTranscriptEntry({
  entry,
  width,
}: {
  readonly entry: ConversationEntry;
  readonly width?: number;
}): React.JSX.Element {
  const cols = width ?? 80;
  const rows = wrapAnsiToWidth(entry.text, cols).split('\n');
  return (
    <Box flexDirection="column">
      <Text>{rows.join('\n')}</Text>
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
  const { pending } = splitTranscriptEntries(entries, slice?.status);
  const maxRows = props.maxRows ?? DEFAULT_TRANSCRIPT_ROWS;
  const visiblePending = selectPendingEntriesForViewport(
    pending,
    maxRows,
    props.width,
  );
  const pendingRows =
    pending.length > 0
      ? Math.max(MIN_PENDING_ROWS, visiblePending.usedRows)
      : 0;

  return (
    <Box flexDirection="column" height={pendingRows} overflowY="hidden">
      {/* `pending` interleaves the in-flight assistant entry with tool
       *  rows in stream order — rendering them as separate buckets would
       *  flip the visible order when the model emits text before a tool
       *  call. The explicit height keeps the input bar pinned and prevents
       *  tool bursts from stealing rows reserved for the footer chrome. */}
      <Box flexDirection="column" height={pendingRows} overflowY="hidden">
        {visiblePending.entries.map((entry) => {
          const rowLimit = visiblePending.rowLimits.get(entry.id);
          if (rowLimit !== undefined) {
            return (
              <BoundedTranscriptEntry
                key={entry.id}
                entry={entry}
                maxRows={rowLimit}
                width={props.width}
              />
            );
          }
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
