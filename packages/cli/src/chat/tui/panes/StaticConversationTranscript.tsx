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
import {
  childStreamDisplayLabel,
  streamScopeDisplayLabel,
} from '../state/streamLabels';
import { transcriptEntryLines } from '../state/transcriptLines';
import { useSignal } from '../state/useSignal';
import { TranscriptEntry } from './TranscriptEntry';

export type StaticTranscriptItem =
  | {
      readonly id: string;
      readonly kind: 'header';
      readonly compact: boolean;
      readonly identityLine: string;
      readonly meta: SessionMeta;
    }
  | {
      readonly id: string;
      readonly kind: 'entry';
      readonly entry: ConversationEntry;
    };

interface StaticTranscriptState {
  readonly ownerKey: string;
  readonly items: readonly StaticTranscriptItem[];
}

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

export function sessionHeaderIdentityLine(
  meta: SessionMeta,
  context: {
    readonly parentStream?: ReadonlyMap<StreamTabId, StreamTabId>;
    readonly streamId?: StreamTabId;
    readonly streams?: ReadonlyMap<StreamTabId, StreamSlice>;
  } = {},
): string {
  const model = meta.model || '—';
  const parentStreamId =
    context.streamId && context.parentStream?.get(context.streamId);
  if (context.streamId && parentStreamId && context.streams) {
    const parentLabel = streamScopeDisplayLabel({
      parentStream: context.parentStream ?? new Map(),
      streamId: parentStreamId,
      streams: context.streams,
    });
    const childLabel = childStreamDisplayLabel(
      context.streams.get(parentStreamId),
      context.streamId,
    );
    return `subagent: ${childLabel} · parent: ${parentLabel} · model: ${model}`;
  }
  if (meta.teamName) {
    return `team: ${meta.teamName} · root: ${meta.agent || 'chat'} · model: ${model}`;
  }
  return `agent: ${meta.agent || 'chat'} · model: ${model}`;
}

function SessionHeaderBlock({
  compact,
  identityLine,
  meta,
  width,
}: {
  readonly compact: boolean;
  readonly identityLine: string;
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
          <Text>{identityLine}</Text>
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
          <Text wrap="truncate-end">{identityLine}</Text>
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
  currentItems,
  streams,
  meta,
  maxRows,
  parentStream = new Map(),
  scrollbackStreamId,
  width,
}: {
  readonly currentItems: readonly StaticTranscriptItem[];
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly meta: SessionMeta;
  readonly maxRows?: number;
  readonly parentStream?: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly scrollbackStreamId: StreamTabId | undefined;
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
      identityLine: sessionHeaderIdentityLine(meta, {
        parentStream,
        streamId: scrollbackStreamId,
        streams,
      }),
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

  // Only the selected scrollback owner feeds `<Static>` output. Root focus owns
  // root history; child focus owns that child's history. Other streams stay
  // available through their own focus or the transcript viewer.
  if (!scrollbackStreamId) return nextItems;
  const slice = streams.get(scrollbackStreamId);
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
  scrollbackStreamId,
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly maxRows?: number;
  readonly scrollbackStreamId: StreamTabId | undefined;
  readonly width?: number;
}): React.JSX.Element {
  const streams = useSignal(cliState.streams);
  const sessionMeta = useSignal(cliState.sessionMeta);
  const parentStream = useSignal(cliState.parentStream);
  const ownerKey = scrollbackStreamId ?? 'none';
  const [state, setState] = useState<StaticTranscriptState>(() => ({
    ownerKey,
    items: appendStaticTranscriptItems({
      currentItems: [],
      streams,
      meta: sessionMeta,
      maxRows,
      parentStream,
      scrollbackStreamId,
      width,
    }),
  }));

  const items =
    state.ownerKey === ownerKey
      ? state.items
      : appendStaticTranscriptItems({
          currentItems: [],
          streams,
          meta: sessionMeta,
          maxRows,
          parentStream,
          scrollbackStreamId,
          width,
        });

  useEffect(() => {
    // On a hard reset (e.g. /clear, picker-to-chat handoff) start the
    // items list from scratch so the header is the first thing the user
    // sees after the scrollback was wiped. A scrollback-owner switch also
    // starts from scratch because root and child histories must not share
    // append-only Static state.
    const isHardReset = streams.size === 0 && scrollbackStreamId === undefined;
    setState((current) => {
      const ownerChanged = current.ownerKey !== ownerKey;
      const nextItems = appendStaticTranscriptItems({
        currentItems: isHardReset || ownerChanged ? [] : current.items,
        streams,
        meta: sessionMeta,
        maxRows,
        parentStream,
        scrollbackStreamId,
        width,
      });
      if (current.ownerKey === ownerKey && current.items === nextItems) {
        return current;
      }
      return { ownerKey, items: nextItems };
    });
  }, [
    maxRows,
    ownerKey,
    parentStream,
    scrollbackStreamId,
    sessionMeta,
    streams,
    width,
  ]);

  return (
    // Remount <Static> on a width or owner change so Ink regenerates
    // `fullStaticOutput` for the current stream. Without the owner key, a focus
    // switch would keep the previous stream's append-only cache.
    <Static
      key={`${ownerKey}:${Math.max(1, Math.floor(width ?? 80))}`}
      items={[...items]}
    >
      {(item: StaticTranscriptItem) => (
        <Box key={item.id} flexDirection="column">
          {item.kind === 'header' ? (
            <SessionHeaderBlock
              compact={item.compact}
              identityLine={item.identityLine}
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
