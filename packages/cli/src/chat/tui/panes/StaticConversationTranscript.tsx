// Session header plus finalized transcript entries. The header is the first
// static row for the active scrollback owner; finalized entries append after it
// in ordinary terminal scrollback through Ink `<Static>`. On a width change,
// the width-qualified Static identity remounts these same items so patched Ink
// can replace its accumulated static output with the new geometry. What the
// retained tail contains, what it costs and when it moves to a new origin
// lives in `staticTranscriptRing.ts`; the chat holds it in one
// `SubscriptionRef`.

import path from 'node:path';

import * as os from 'node:os';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { SubscriptionRef } from 'effect';
import { Box, Static, Text } from 'ink';
import type { TranscriptRow } from '@cli/chat/tui/state/sessionView';

import { COLOR_HINT } from '@cli/tui/ui/colors';

import {
  sessionMeta as sessionMetaSignal,
  type SessionMeta,
} from '../state/cliState';
import { sessionView, runLabelOf, runViewOf } from '../state/sessionView';
import {
  mergeLocalNotices,
  notices as noticesSignal,
  noticesFor,
} from '../state/transcript';
import { useSignal } from '../state/useSignal';
import { useSubscriptionRef } from '../state/useSubscriptionRef';
import { EntryErrorBoundary } from './EntryErrorBoundary';
import {
  advanceScrollback,
  type ChatScrollback,
  type ChildHeader,
  type StaticScrollbackSource,
  type StaticTranscriptItem,
} from './staticTranscriptRing';
import { TranscriptEntry } from './TranscriptEntry';
import { transcriptColumns } from './transcriptEntryLayout';
import type { SessionView, RunId } from '@texra-ai/harness/schemas';
import { isWorking } from '@texra-ai/harness/schemas';

function shortenCwd(cwd: string): string {
  let home: string;
  try {
    home = os.homedir();
  } catch {
    // No resolvable home (UV_ENOENT): the `~` shortening is cosmetic, so show the full cwd.
    return cwd;
  }
  if (cwd === home) return '~';
  const sep = path.sep;
  if (cwd.startsWith(`${home}${sep}`)) {
    return `~${sep}${cwd.slice(home.length + sep.length)}`;
  }
  return cwd;
}

function childHeaderFor(
  view: SessionView,
  runId: RunId | undefined,
): ChildHeader | undefined {
  const child = runViewOf(view, runId);
  if (!child?.parentId) return undefined;
  const parent = runViewOf(view, child.parentId);
  return {
    label: child.label,
    modelLabel: child.modelLabel,
    childKind: child.identity.kind === 'script' ? 'script' : 'subagent',
    parentLabel: parent === undefined ? 'main' : runLabelOf(parent),
  };
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
          <Text dimColor>v{meta.version}</Text> <Text>{identityLine}</Text>
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

/** The transcript entry an item sits directly below, when that neighbor is
 *  itself an entry. A header above carries no margin for the next entry to
 *  collapse against. */
function entryAbove(
  item: StaticTranscriptItem | undefined,
): TranscriptRow | undefined {
  return item?.kind === 'entry' ? item.entry : undefined;
}

function StaticTranscriptItemContent({
  item,
  previousItem,
  width,
}: {
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
        <EntryErrorBoundary label={item.entry.kind}>
          <TranscriptEntry
            entry={item.entry}
            previousEntry={entryAbove(previousItem)}
            width={width}
          />
        </EntryErrorBoundary>
      );
  }
}

export function StaticConversationTranscript({
  maxRows,
  ownerKey,
  scrollback,
  scrollbackRunId,
  width,
}: {
  readonly maxRows?: number;
  readonly ownerKey: string;
  readonly scrollback: ChatScrollback;
  readonly scrollbackRunId: RunId | undefined;
  readonly width?: number;
}): React.JSX.Element {
  const normalizedWidth = transcriptColumns(width);
  const view = useSignal(sessionView());
  const allNotices = useSignal(noticesSignal);
  const sessionMeta = useSignal(sessionMetaSignal);
  const source = useMemo((): StaticScrollbackSource => {
    const stream = runViewOf(view, scrollbackRunId);
    const runNotices = noticesFor(allNotices, scrollbackRunId);
    const merged = mergeLocalNotices(stream, runNotices);
    return {
      entries:
        stream === undefined && runNotices.length === 0
          ? undefined
          : merged.rows,
      settledRows: merged.settledRows,
      working: stream != null && isWorking(stream),
      waitingForChildIdentity:
        stream !== undefined &&
        stream.parentId !== null &&
        stream.identity.kind === 'agent' &&
        stream.model === null,
      child: childHeaderFor(view, scrollbackRunId),
    };
  }, [allNotices, scrollbackRunId, view]);
  // Advance before committing the render, so a tick never commits stale rows
  // first; the advanced record is stored once the render commits.
  const current = useSubscriptionRef(scrollback.runtime, scrollback.ref);
  const next = advanceScrollback(current, {
    maxRows,
    meta: sessionMeta,
    ownerKey,
    source,
    width: normalizedWidth,
  });
  // The origin the terminal shows. A new one is repainted in the same commit
  // that remounts `<Static>`, while the remounted items are still in Ink's
  // tree.
  const paintedOrigin = useRef(next.origin);
  useLayoutEffect(() => {
    if (next !== current) {
      scrollback.runtime.runSync(SubscriptionRef.set(scrollback.ref, next));
    }
    if (paintedOrigin.current !== next.origin) {
      paintedOrigin.current = next.origin;
      scrollback.repaint();
    }
  }, [current, next, scrollback]);
  const staticItems = useMemo(() => [...next.items], [next.items]);
  return (
    <Static
      key={`transcript:${next.origin}:${normalizedWidth}`}
      items={staticItems}
    >
      {(item: StaticTranscriptItem, index: number) => (
        <Box key={item.id} flexDirection="column">
          <StaticTranscriptItemContent
            item={item}
            previousItem={staticItems[index - 1]}
            width={normalizedWidth}
          />
        </Box>
      )}
    </Static>
  );
}
