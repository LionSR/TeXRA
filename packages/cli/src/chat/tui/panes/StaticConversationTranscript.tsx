// Session header plus finalized transcript entries. The header is the first
// static row for the active scrollback owner; finalized entries append after it
// in ordinary terminal scrollback through Ink `<Static>`. On a width change,
// the width-qualified Static identity remounts these same items so patched Ink
// can replace its accumulated static output with the new geometry.

import path from 'node:path';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text } from 'ink';

import { shortCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import type { StreamTabId } from '@shared/schemas';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';
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
import { useSignal } from '../state/useSignal';
import { EntryErrorBoundary } from './EntryErrorBoundary';
import { orderedStaticTranscriptEntries } from './transcriptEntries';
import { TranscriptEntry } from './TranscriptEntry';
import {
  transcriptColumns,
  transcriptEntryLayout,
  transcriptEntryLayoutRows,
} from './transcriptEntryLayout';

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
    const streamKind =
      slice?.identity?.kind === 'multiAgentWorkflow'
        ? 'workflow script'
        : 'subagent';
    return `${streamKind}: ${view.label} · parent: ${view.parentLabel} · model: ${model}`;
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
  const columns = transcriptColumns(width);
  if (compact) {
    return (
      <Box paddingX={1}>
        <Text wrap="truncate-end">
          <Text bold color={COLOR_HINT}>
            {'{ T } TeXRA'}
          </Text>{' '}
          <Text dimColor>v{meta.version}</Text>{' '}
          <Text dimColor>{shortCliModelAccessRoute(meta.apiMode)}</Text>{' '}
          <Text>{identityLine}</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box
        aria-hidden
        width={columns}
        borderStyle="single"
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderColor={COLOR_HINT}
      />
      <Box flexDirection="column" paddingX={1}>
        <Box gap={2}>
          <Text bold color={COLOR_HINT}>
            {'{ T } TeXRA'}
          </Text>
          <Text dimColor>v{meta.version}</Text>
          <Text dimColor>{shortCliModelAccessRoute(meta.apiMode)}</Text>
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

function staticTranscriptItemRowCount(
  item: StaticTranscriptItem,
  width?: number,
  executionLabels?: ExecutionLabels,
  previousItem?: StaticTranscriptItem,
): number {
  if (item.kind === 'header') {
    return item.compact
      ? COMPACT_SESSION_HEADER_ROWS
      : FULL_SESSION_HEADER_ROWS;
  }
  return transcriptEntryLayoutRows(
    transcriptEntryLayout(item.entry, {
      executionLabels,
      mode: 'scrollback-budget',
      previousEntry: entryAbove(previousItem),
      width,
    }),
  );
}

/** The transcript entry an item sits directly below, when that neighbor is
 *  itself an entry. A header above carries no margin for the next entry to
 *  collapse against. */
function entryAbove(
  item: StaticTranscriptItem | undefined,
): ConversationEntry | undefined {
  return item?.kind === 'entry' ? item.entry : undefined;
}

function StaticTranscriptItemContent({
  colorEnabled,
  executionLabels,
  item,
  previousItem,
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly executionLabels?: ExecutionLabels;
  readonly item: StaticTranscriptItem;
  readonly previousItem?: StaticTranscriptItem;
  readonly width: number;
}): React.JSX.Element {
  switch (item.kind) {
    case 'header':
      return (
        <EntryErrorBoundary label="session header">
          <SessionHeaderBlock
            compact={item.compact}
            identityLine={item.identityLine}
            meta={item.meta}
            width={width}
          />
        </EntryErrorBoundary>
      );
    case 'entry':
      return (
        <EntryErrorBoundary label={item.entry.role}>
          <TranscriptEntry
            entry={item.entry}
            previousEntry={entryAbove(previousItem)}
            subagentExecutionLabels={executionLabels}
            width={width}
            colorEnabled={colorEnabled}
          />
        </EntryErrorBoundary>
      );
  }
}

export function appendStaticTranscriptItems({
  currentItems,
  streams,
  childStreamEntries = new Map(),
  executionLabels,
  meta,
  maxRows,
  parentStream = new Map(),
  scrollbackStreamId,
  width,
}: {
  readonly currentItems: readonly StaticTranscriptItem[];
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly childStreamEntries?: ChildStreamEntries;
  readonly executionLabels?: ExecutionLabels;
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
    scrollbackStreamId !== undefined &&
    parentStream.has(scrollbackStreamId) &&
    !streams.get(scrollbackStreamId)?.model;
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
        (total, item, index) =>
          total +
          staticTranscriptItemRowCount(
            item,
            width,
            executionLabels,
            index === 0 ? header : currentItems[index - 1],
          ),
        staticTranscriptItemRowCount(header, width, executionLabels),
      ) <= maxRows;
    if (fitsBudget) {
      nextItems = [...currentItems];
      const firstEntryIndex = nextItems.findIndex(
        (item) => item.kind !== 'header',
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
  // available through their own focus.
  const slice = scrollbackStreamId
    ? streams.get(scrollbackStreamId)
    : undefined;
  const entries = slice?.entries ?? [];
  const orderedStaticEntries = orderedStaticTranscriptEntries(
    entries,
    slice?.status,
  );
  const appendItem = (item: StaticTranscriptItem): void => {
    nextItems ??= [...currentItems];
    nextItems.push(item);
    seen.add(item.id);
  };

  for (const entry of orderedStaticEntries) {
    if (!seen.has(entry.id)) {
      appendItem({ id: entry.id, kind: 'entry', entry });
    }
  }
  // Same reference when nothing was appended so the `setItems` functional
  // update doesn't schedule a re-render on every stream-sync tick.
  return nextItems ?? currentItems;
}

export function StaticConversationTranscript({
  colorEnabled,
  maxRows,
  onRenderKeyChange,
  ownerKey,
  renderKey = ownerKey,
  scrollbackStreamId,
  subagentExecutionLabels,
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly maxRows?: number;
  readonly onRenderKeyChange?: () => void;
  readonly ownerKey: string;
  readonly renderKey?: string;
  readonly scrollbackStreamId: StreamTabId | undefined;
  readonly subagentExecutionLabels?: ExecutionLabels;
  readonly width?: number;
}): React.JSX.Element {
  const normalizedWidth = transcriptColumns(width);
  const previousRenderKey = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const previous = previousRenderKey.current;
    previousRenderKey.current = renderKey;
    if (previous !== undefined && previous !== renderKey) {
      onRenderKeyChange?.();
    }
  }, [onRenderKeyChange, renderKey]);
  const streams = useSignal(streamsSignal);
  const sessionMeta = useSignal(sessionMetaSignal);
  const parentStream = useSignal(parentStreamSignal);
  const childStreamEntries = useSignal(childStreamEntriesSignal);
  const buildFreshItems = (): readonly StaticTranscriptItem[] =>
    appendStaticTranscriptItems({
      currentItems: [],
      streams,
      childStreamEntries,
      executionLabels: subagentExecutionLabels,
      meta: sessionMeta,
      maxRows,
      parentStream,
      scrollbackStreamId,
      width: normalizedWidth,
    });
  const [state, setState] = useState<StaticTranscriptState>(() => ({
    ownerKey,
    items: buildFreshItems(),
  }));

  const items = state.ownerKey === ownerKey ? state.items : buildFreshItems();

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
        executionLabels: subagentExecutionLabels,
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
    subagentExecutionLabels,
    normalizedWidth,
  ]);

  // Keep our scrollback state readonly and adapt once at the Ink boundary.
  // `<Static>` declares `items: T[]`; memoizing the defensive copy avoids the
  // old O(history) spread on unrelated renders without exposing state to a
  // mutable third-party prop.
  const staticItems = useMemo(() => [...items], [items]);

  return (
    <Static
      key={`transcript:${renderKey}:${normalizedWidth}`}
      items={staticItems}
    >
      {(item: StaticTranscriptItem, index: number) => (
        <Box key={item.id} flexDirection="column">
          <StaticTranscriptItemContent
            colorEnabled={colorEnabled}
            executionLabels={subagentExecutionLabels}
            item={item}
            previousItem={staticItems[index - 1]}
            width={normalizedWidth}
          />
        </Box>
      )}
    </Static>
  );
}
