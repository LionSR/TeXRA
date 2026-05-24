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
} from '../state/cliState';
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
