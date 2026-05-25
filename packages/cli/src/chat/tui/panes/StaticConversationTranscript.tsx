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
import { useSignal } from '../state/useSignal';
import { TranscriptEntry } from './TranscriptEntry';

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
  const home = safeHomedir();
  if (!home) return cwd;
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

// Dedupe `<Static>` rows by the entry's own id (a randomUUID from the
// stream log, or a unique `local:…` id for synthetic rows) rather than
// pairing it with the stream id. `moveLocalTranscriptToStream` re-homes
// pre-agent local rows onto the real stream keeping their id; a
// stream-scoped key would treat the moved rows as new and print them
// twice.
const SESSION_HEADER_ID = 'session-header';

export function appendStaticTranscriptItems({
  activeStreamId,
  currentItems,
  streams,
  meta,
}: {
  readonly activeStreamId: string | undefined;
  readonly currentItems: readonly StaticTranscriptItem[];
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly meta: SessionMeta;
}): readonly StaticTranscriptItem[] {
  const seen = new Set(currentItems.map((item) => item.id));
  const nextItems: StaticTranscriptItem[] = [...currentItems];
  if (!seen.has(SESSION_HEADER_ID)) {
    nextItems.push({ id: SESSION_HEADER_ID, kind: 'header', meta });
    seen.add(SESSION_HEADER_ID);
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
    nextItems.push({ id: entry.id, kind: 'entry', entry });
    seen.add(entry.id);
  }
  // Same reference when nothing was appended so the `setItems` functional
  // update doesn't schedule a re-render on every stream-sync tick.
  return nextItems.length === currentItems.length ? currentItems : nextItems;
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
        activeStreamId,
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
