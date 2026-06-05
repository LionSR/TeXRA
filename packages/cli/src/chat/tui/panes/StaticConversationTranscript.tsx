// Print-once transcript rendered through Ink `<Static>` so finalized entries
// land in ordinary terminal scrollback. The session header is the first
// static item; finalized conversation entries follow as they promote.

import path from 'node:path';

import { useEffect, useState } from 'react';
import { Box, Static, Text } from 'ink';

import { shortCliApiMode } from '@cli/runtime/apiAccessMode';
import type { StreamTabId } from '@shared/schemas';
import { safeHomedir } from '@utils/system/platformPaths';

import {
  cliState,
  type ConversationEntry,
  type SessionMeta,
  type StreamSlice,
} from '../state/cliState';
import { transcriptEntryLines } from '../state/transcriptLines';
import { useSignal } from '../state/useSignal';
import { TranscriptEntry } from './TranscriptEntry';

export type StaticTranscriptItem =
  | {
      readonly id: string;
      readonly kind: 'header';
      readonly compact: boolean;
      readonly meta: SessionMeta;
    }
  | {
      readonly id: string;
      readonly kind: 'entry';
      readonly entry: ConversationEntry;
    };

function shortenCwd(cwd: string): string {
  const home = safeHomedir();
  if (!home) return cwd;
  if (cwd === home) return '~';
  const sep = path.sep;
  if (cwd.startsWith(`${home}${sep}`)) {
    return `~${sep}${cwd.slice(home.length + sep.length)}`;
  }
  return cwd;
}

export function sessionHeaderIdentityLine(meta: SessionMeta): string {
  const model = meta.model || '—';
  if (meta.teamName) {
    return `team: ${meta.teamName} · root: ${meta.agent || 'chat'} · model: ${model}`;
  }
  return `agent: ${meta.agent || 'chat'} · model: ${model}`;
}

function SessionHeaderBlock({
  compact,
  meta,
  width,
}: {
  readonly compact: boolean;
  readonly meta: SessionMeta;
  readonly width?: number;
}): React.JSX.Element {
  const columns = Math.max(1, Math.floor(width ?? 80));
  if (compact) {
    return (
      <Box paddingX={1}>
        <Text wrap="truncate-end">
          <Text bold color="cyan">
            TeXRA
          </Text>{' '}
          <Text dimColor>v{meta.version}</Text>{' '}
          <Text dimColor>{shortCliApiMode(meta.apiMode)}</Text>{' '}
          <Text>{sessionHeaderIdentityLine(meta)}</Text>
        </Text>
      </Box>
    );
  }

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
          <Text wrap="truncate-end">{sessionHeaderIdentityLine(meta)}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {shortenCwd(meta.cwd)}
        </Text>
      </Box>
    </Box>
  );
}

// Dedupe `<Static>` rows by the entry's own id (a randomUUID from the
// stream log, or a unique `local:…` id for synthetic rows) rather than
// pairing it with the stream id. `moveLocalTranscriptToStream` re-homes
// pre-agent local rows onto the real stream keeping their id; a
// stream-scoped key would treat the moved rows as new and print them
// twice.
const SESSION_HEADER_ID = 'session-header';
const FULL_SESSION_HEADER_ROWS = 4;
const COMPACT_SESSION_HEADER_ROWS = 1;

function staticTranscriptItemRowCount(
  item: StaticTranscriptItem,
  width?: number,
): number {
  if (item.kind === 'header') {
    return item.compact
      ? COMPACT_SESSION_HEADER_ROWS
      : FULL_SESSION_HEADER_ROWS;
  }
  // Compact budgeting can over-count tool rows because the transcript viewer
  // keeps full tool output while the static scrollback renderer elides it.
  return transcriptEntryLines(item.entry, Math.max(1, Math.floor(width ?? 80)))
    .length;
}

export function appendStaticTranscriptItems({
  activeStreamId,
  currentItems,
  streams,
  meta,
  maxRows,
  width,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly currentItems: readonly StaticTranscriptItem[];
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly meta: SessionMeta;
  readonly maxRows?: number;
  readonly width?: number;
}): readonly StaticTranscriptItem[] {
  const seen = new Set(currentItems.map((item) => item.id));
  const nextItems: StaticTranscriptItem[] = [...currentItems];
  let currentRows = nextItems.reduce(
    (total, item) => total + staticTranscriptItemRowCount(item, width),
    0,
  );
  if (!seen.has(SESSION_HEADER_ID)) {
    const header: StaticTranscriptItem = {
      id: SESSION_HEADER_ID,
      kind: 'header',
      compact: maxRows !== undefined && maxRows < FULL_SESSION_HEADER_ROWS,
      meta,
    };
    if (
      maxRows === undefined ||
      currentRows + staticTranscriptItemRowCount(header, width) <= maxRows
    ) {
      nextItems.push(header);
      currentRows += staticTranscriptItemRowCount(header, width);
      seen.add(SESSION_HEADER_ID);
    }
  }

  // Only the active stream feeds the shared `<Static>` scrollback. Dumping
  // every stream here floods the main transcript with each subagent's tool
  // calls and file reads, interleaving them with the live side panel.
  // Subagent activity is surfaced in the live region when its tab is
  // focused instead.
  if (!activeStreamId) return nextItems;
  const slice = streams.get(activeStreamId);
  for (const entry of slice?.entries ?? []) {
    if (!entry.finalized) continue;
    if (seen.has(entry.id)) continue;
    const item: StaticTranscriptItem = { id: entry.id, kind: 'entry', entry };
    nextItems.push(item);
    seen.add(entry.id);
  }
  // Same reference when nothing was appended so the `setItems` functional
  // update doesn't schedule a re-render on every stream-sync tick.
  return nextItems.length === currentItems.length ? currentItems : nextItems;
}

export function StaticConversationTranscript({
  colorEnabled,
  maxRows,
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly maxRows?: number;
  readonly width?: number;
}): React.JSX.Element {
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const sessionMeta = useSignal(cliState.sessionMeta);
  const [items, setItems] = useState<readonly StaticTranscriptItem[]>(() =>
    appendStaticTranscriptItems({
      activeStreamId,
      currentItems: [],
      streams,
      meta: sessionMeta,
      maxRows,
      width,
    }),
  );

  useEffect(() => {
    // On a hard reset (e.g. /clear, picker-to-chat handoff) start the
    // items list from scratch so the header is the first thing the user
    // sees after the scrollback was wiped. Focused child streams do not
    // mount this static scrollback; they render their own bounded history.
    const isHardReset = streams.size === 0 && activeStreamId === undefined;
    setItems((currentItems) =>
      appendStaticTranscriptItems({
        activeStreamId,
        currentItems: isHardReset ? [] : currentItems,
        streams,
        meta: sessionMeta,
        maxRows,
        width,
      }),
    );
  }, [activeStreamId, maxRows, sessionMeta, streams, width]);

  return (
    // Remount <Static> on a width change so Ink regenerates `fullStaticOutput`
    // at the new width (via its handleStaticChange identity-reset). Without this
    // the resize full-repaint reprints the cached, baked-width static output, so
    // fixed-width content (e.g. the full-width user-message band) can't reflow.
    <Static key={Math.max(1, Math.floor(width ?? 80))} items={[...items]}>
      {(item: StaticTranscriptItem) => (
        <Box key={item.id} flexDirection="column">
          {item.kind === 'header' ? (
            <SessionHeaderBlock
              compact={item.compact}
              meta={item.meta}
              width={width}
            />
          ) : (
            <TranscriptEntry
              entry={item.entry}
              width={width}
              colorEnabled={colorEnabled}
            />
          )}
        </Box>
      )}
    </Static>
  );
}
