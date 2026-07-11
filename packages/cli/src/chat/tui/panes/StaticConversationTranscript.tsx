// Session header plus finalized transcript entries. The header is the first
// static row for the active scrollback owner; finalized entries append after it
// in ordinary terminal scrollback through Ink `<Static>`. On a width change,
// the width-qualified Static identity remounts these same items so patched Ink
// can replace its accumulated static output with the new geometry.

import path from 'node:path';

import { useEffect, useMemo, useState } from 'react';
import { Box, Static, Text } from 'ink';

import { shortCliApiMode } from '@cli/runtime/apiAccessMode';
import type { StreamTabId } from '@shared/schemas';
import { safeHomedir } from '@utils/system/platformPaths';

import {
  sessionMeta as sessionMetaSignal,
  streams as streamsSignal,
  type ConversationEntry,
  type SessionMeta,
  type StreamSlice,
} from '../state/cliState';
import {
  childStreamEntries as childStreamEntriesSignal,
  parentStream as parentStreamSignal,
  type ChildStreamEntries,
} from '../state/childExecutions';
import { streamViewForId } from '../state/streamViews';
import { transcriptEntryLines } from '../state/transcriptLines';
import { useSignal } from '../state/useSignal';
import { EntryErrorBoundary } from './EntryErrorBoundary';
import {
  isInquiryContinuationText,
  isRenderableTranscriptEntry,
  nextRenderableTranscriptEntry,
  userPromptAwaitsLiveContinuation,
} from './transcriptEntries';
import {
  ASSISTANT_ENTRY_MARGIN_BOTTOM_ROWS,
  PROCESS_ENTRY_MARGIN_BOTTOM_ROWS,
  TranscriptEntry,
  USER_ENTRY_MARGIN_BOTTOM_ROWS,
  USER_ENTRY_MARGIN_TOP_ROWS,
} from './TranscriptEntry';

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
      readonly userBottomMarginRows?: number;
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
    readonly childStreamEntries?: ChildStreamEntries;
    readonly parentStream?: ReadonlyMap<StreamTabId, StreamTabId>;
    readonly streamId?: StreamTabId;
    readonly streams?: ReadonlyMap<StreamTabId, StreamSlice>;
  } = {},
): string {
  const parentStream = context.parentStream;
  const parentStreamId =
    context.streamId && parentStream?.get(context.streamId);
  if (context.streamId && parentStreamId && parentStream && context.streams) {
    const slice = context.streams.get(context.streamId);
    const model = slice?.model || meta.model || '—';
    const view = streamViewForId({
      activeStreamId: context.streamId,
      childStreamEntries: context.childStreamEntries ?? new Map(),
      parentStream,
      streamId: context.streamId,
      streams: context.streams,
    });
    return `subagent: ${view.label} · parent: ${view.parentLabel} · model: ${model}`;
  }
  const model = meta.model || '—';
  const agent = meta.agent || 'chat';
  if (meta.teamName) {
    return `team: ${meta.teamName} · root: ${agent} · model: ${model}`;
  }
  return `agent: ${agent} · model: ${model}`;
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
            {'{ T } TeXRA'}
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
        <Text aria-hidden color="cyan">
          {'─'.repeat(columns)}
        </Text>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        <Box gap={2}>
          <Text bold color="cyan">
            {'{ T } TeXRA'}
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

// Dedupe `<Static>` rows by the entry's own id (a random id from the
// stream log, or a unique `local:…` id for synthetic rows) rather than
// pairing it with the stream id. `moveLocalTranscriptToStream` re-homes
// pre-agent local rows onto the real stream keeping their id; a
// stream-scoped key would treat the moved rows as new and print them
// twice.
const SESSION_HEADER_ID = 'session-header';
const FULL_SESSION_HEADER_ROWS = 4;
const COMPACT_SESSION_HEADER_ROWS = 1;

function childHeaderIdentityPending({
  parentStream,
  scrollbackStreamId,
  streams,
}: {
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly scrollbackStreamId: StreamTabId | undefined;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): boolean {
  return (
    scrollbackStreamId !== undefined &&
    parentStream.has(scrollbackStreamId) &&
    !streams.get(scrollbackStreamId)?.model
  );
}

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
  const cols = Math.max(1, Math.floor(width ?? 80));
  const isUserBand =
    item.entry.role === 'user' && !isInquiryContinuationText(item.entry.text);
  const isPaddedPrefixRow =
    item.entry.role === 'user' || item.entry.role === 'error';
  // Pass cols-2 for user/error entries: transcriptEntryLines subtracts the
  // 2-char prefix internally, so the effective wrap width is cols-4,
  // matching the paddingX={1} + prefix geometry of the renderer.
  const lines = transcriptEntryLines(
    item.entry,
    isPaddedPrefixRow ? Math.max(1, cols - 2) : cols,
  ).length;
  let marginRows = 0;
  if (isUserBand) {
    marginRows =
      USER_ENTRY_MARGIN_TOP_ROWS +
      (item.userBottomMarginRows ?? USER_ENTRY_MARGIN_BOTTOM_ROWS);
  } else if (item.entry.role === 'assistant') {
    marginRows = ASSISTANT_ENTRY_MARGIN_BOTTOM_ROWS;
  } else if (item.entry.role === 'process') {
    marginRows = PROCESS_ENTRY_MARGIN_BOTTOM_ROWS;
  }
  return lines + marginRows;
}

function staticUserBottomMarginRows({
  entry,
  nextEntry,
}: {
  readonly entry: ConversationEntry;
  readonly nextEntry: ConversationEntry | undefined;
}): number | undefined {
  const isUserBand =
    entry.role === 'user' && !isInquiryContinuationText(entry.text);
  if (!isUserBand) return undefined;
  // Tool rows are the command execution part of the same turn; keep them
  // attached to the prompt instead of printing a gap row.
  if (nextEntry?.role === 'tool') return 0;
  return USER_ENTRY_MARGIN_BOTTOM_ROWS;
}

export function appendStaticTranscriptItems({
  currentItems,
  streams,
  childStreamEntries = new Map(),
  meta,
  maxRows,
  parentStream = new Map(),
  scrollbackStreamId,
  width,
}: {
  readonly currentItems: readonly StaticTranscriptItem[];
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly childStreamEntries?: ChildStreamEntries;
  readonly meta: SessionMeta;
  readonly maxRows?: number;
  readonly parentStream?: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly scrollbackStreamId: StreamTabId | undefined;
  readonly width?: number;
}): readonly StaticTranscriptItem[] {
  const seen = new Set(currentItems.map((item) => item.id));
  // Copied lazily: this runs on every stream-sync tick and most ticks append
  // nothing.
  let nextItems: StaticTranscriptItem[] | undefined;
  const shouldWaitForChildIdentity =
    !seen.has(SESSION_HEADER_ID) &&
    childHeaderIdentityPending({ parentStream, scrollbackStreamId, streams });
  if (shouldWaitForChildIdentity) return currentItems;

  if (!seen.has(SESSION_HEADER_ID)) {
    const header: StaticTranscriptItem = {
      id: SESSION_HEADER_ID,
      kind: 'header',
      compact: maxRows !== undefined && maxRows < FULL_SESSION_HEADER_ROWS,
      identityLine: sessionHeaderIdentityLine(meta, {
        childStreamEntries,
        parentStream,
        streamId: scrollbackStreamId,
        streams,
      }),
      meta,
    };
    // The row budget only applies on compact terminals (maxRows defined), and
    // counting rows wraps every item's full text — O(history) — so it must
    // stay behind the maxRows gate rather than run eagerly per tick.
    const fitsBudget =
      maxRows === undefined ||
      currentItems.reduce(
        (total, item) => total + staticTranscriptItemRowCount(item, width),
        staticTranscriptItemRowCount(header, width),
      ) <= maxRows;
    if (fitsBudget) {
      nextItems = [...currentItems];
      const firstEntryIndex = nextItems.findIndex(
        (item) => item.kind === 'entry',
      );
      nextItems.splice(
        firstEntryIndex < 0 ? nextItems.length : firstEntryIndex,
        0,
        header,
      );
      seen.add(SESSION_HEADER_ID);
    }
  }

  // Only the selected scrollback owner feeds `<Static>` output. Root focus owns
  // root history; child focus owns that child's history. Other streams stay
  // available through their own focus or the transcript viewer.
  const slice = scrollbackStreamId
    ? streams.get(scrollbackStreamId)
    : undefined;
  const entries = slice?.entries ?? [];
  for (const [index, entry] of entries.entries()) {
    if (!isRenderableTranscriptEntry(entry)) continue;
    if (userPromptAwaitsLiveContinuation(entries, index, slice?.status)) {
      continue;
    }
    if (!entry.finalized) continue;
    if (seen.has(entry.id)) continue;
    nextItems ??= [...currentItems];
    nextItems.push({
      id: entry.id,
      kind: 'entry',
      entry,
      userBottomMarginRows: staticUserBottomMarginRows({
        entry,
        nextEntry: nextRenderableTranscriptEntry(entries, index),
      }),
    });
    seen.add(entry.id);
  }
  // Same reference when nothing was appended so the `setItems` functional
  // update doesn't schedule a re-render on every stream-sync tick.
  return nextItems ?? currentItems;
}

export function StaticConversationTranscript({
  colorEnabled,
  maxRows,
  ownerKey,
  scrollbackStreamId,
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly maxRows?: number;
  readonly ownerKey: string;
  readonly scrollbackStreamId: StreamTabId | undefined;
  readonly width?: number;
}): React.JSX.Element {
  const normalizedWidth = Math.max(1, Math.floor(width ?? 80));
  const streams = useSignal(streamsSignal);
  const sessionMeta = useSignal(sessionMetaSignal);
  const parentStream = useSignal(parentStreamSignal);
  const childStreamEntries = useSignal(childStreamEntriesSignal);
  const [state, setState] = useState<StaticTranscriptState>(() => ({
    ownerKey,
    items: appendStaticTranscriptItems({
      currentItems: [],
      streams,
      childStreamEntries,
      meta: sessionMeta,
      maxRows,
      parentStream,
      scrollbackStreamId,
      width: normalizedWidth,
    }),
  }));

  const items =
    state.ownerKey === ownerKey
      ? state.items
      : appendStaticTranscriptItems({
          currentItems: [],
          streams,
          childStreamEntries,
          meta: sessionMeta,
          maxRows,
          parentStream,
          scrollbackStreamId,
          width: normalizedWidth,
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
        childStreamEntries,
        meta: sessionMeta,
        maxRows,
        parentStream,
        scrollbackStreamId,
        width: normalizedWidth,
      });
      if (current.ownerKey === ownerKey && current.items === nextItems) {
        return current;
      }
      return { ownerKey, items: nextItems };
    });
  }, [
    childStreamEntries,
    maxRows,
    ownerKey,
    parentStream,
    scrollbackStreamId,
    sessionMeta,
    streams,
    normalizedWidth,
  ]);

  // Keep our scrollback state readonly and adapt once at the Ink boundary.
  // `<Static>` declares `items: T[]`; memoizing the defensive copy avoids the
  // old O(history) spread on unrelated renders without exposing state to a
  // mutable third-party prop.
  const staticItems = useMemo(() => [...items], [items]);

  return (
    <Static
      key={`transcript:${ownerKey}:${normalizedWidth}`}
      items={staticItems}
    >
      {(item: StaticTranscriptItem) => (
        <Box key={item.id} flexDirection="column">
          {item.kind === 'header' ? (
            <EntryErrorBoundary label="session header">
              <SessionHeaderBlock
                compact={item.compact}
                identityLine={item.identityLine}
                meta={item.meta}
                width={normalizedWidth}
              />
            </EntryErrorBoundary>
          ) : (
            <EntryErrorBoundary label={item.entry.role}>
              <TranscriptEntry
                entry={item.entry}
                width={normalizedWidth}
                colorEnabled={colorEnabled}
                userBottomMarginRows={item.userBottomMarginRows}
              />
            </EntryErrorBoundary>
          )}
        </Box>
      )}
    </Static>
  );
}
