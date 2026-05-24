// Print-once transcript rendered through Ink `<Static>` so finalized entries
// land in ordinary terminal scrollback. The session header is the first
// static item; finalized conversation entries follow as they promote.

import os from 'node:os';
import path from 'node:path';

import { useEffect, useState } from 'react';
import { Box, Static, Text } from 'ink';

import {
  cliState,
  type ConversationEntry,
  type SessionMeta,
  type StreamSlice,
} from '../state/cliState';
import type { StreamTabId } from '@shared/schemas';
import { useSignal } from '../state/useSignal';
import { TranscriptEntry } from './TranscriptEntry';
import { shortCliApiMode } from '../../../runtime/apiAccessMode';

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

// Keyed on the fields the header actually renders. Any agent / model /
// api-mode / cwd change therefore appends a fresh header block to
// scrollback, surfacing the transition instead of leaving a stale snapshot
// pinned at the top.
function sessionHeaderId(meta: SessionMeta): string {
  return [
    'session-header',
    meta.agent,
    meta.model,
    meta.apiMode,
    meta.cwd,
    meta.version,
  ].join('|');
}

export function appendStaticTranscriptItems({
  currentItems,
  streams,
  meta,
}: {
  readonly currentItems: readonly StaticTranscriptItem[];
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly meta: SessionMeta;
}): readonly StaticTranscriptItem[] {
  const nextItems: StaticTranscriptItem[] = [...currentItems];
  const seen = new Set(nextItems.map((item) => item.id));
  const headerId = sessionHeaderId(meta);
  if (!seen.has(headerId)) {
    nextItems.push({ id: headerId, kind: 'header', meta });
    seen.add(headerId);
  }

  // Iterate every known stream rather than just the active one — Ink
  // `<Static>` prints once into the primary buffer, so a subagent or
  // background tab that finalizes entries while the user is focused
  // elsewhere would otherwise lose that output forever.
  for (const [streamId, slice] of streams) {
    for (const entry of slice.entries) {
      if (!entry.finalized) continue;
      const id = staticEntryId(streamId, entry);
      if (seen.has(id)) continue;
      nextItems.push({ id, kind: 'entry', entry });
      seen.add(id);
    }
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
  const [items, setItems] = useState<readonly StaticTranscriptItem[]>([]);

  useEffect(() => {
    // On a hard reset (e.g. /clear, picker-to-chat handoff) start the
    // items list from scratch so the header is the first thing the user
    // sees after the scrollback was wiped. Otherwise extend the existing
    // items so already-printed `<Static>` lines stay stable.
    const isHardReset = streams.size === 0 && activeStreamId === undefined;
    setItems((currentItems) =>
      appendStaticTranscriptItems({
        currentItems: isHardReset ? [] : currentItems,
        streams,
        meta: sessionMeta,
      }),
    );
  }, [activeStreamId, streams, sessionMeta]);

  return (
    <Static items={[...items]}>
      {(item: StaticTranscriptItem) => (
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
