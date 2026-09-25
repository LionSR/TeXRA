// Session header plus finalized transcript entries. The header is the first
// static row for the active scrollback owner; finalized entries append after it
// in ordinary terminal scrollback through Ink `<Static>`. On a width change,
// the width-qualified Static identity remounts these same items so patched Ink
// can replace its accumulated static output with the new geometry. What the
// retained tail contains and what it costs lives in `staticTranscriptRing.ts`.

import path from 'node:path';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text } from 'ink';

import { COLOR_HINT } from '@cli/tui/ui/colors';
import type { RunId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import type { TranscriptRow } from '@ui/transcript';
import { safeHomedir } from '@utils/system/platformPaths';

import {
  rootRunId as rootRunIdSignal,
  sessionMeta as sessionMetaSignal,
  type SessionMeta,
} from '../state/cliState';
import {
  ancestorPositionLabel,
  sessionView,
  runLabelOf,
  runPhaseOf,
  runViewOf,
} from '../state/sessionView';
import { staticTranscriptEraseEpoch } from '../state/staticTranscriptRepaint';
import {
  mergeLocalNotices,
  notices as noticesSignal,
  noticesFor,
} from '../state/transcript';
import { useSignal } from '../state/useSignal';
import { EntryErrorBoundary } from './EntryErrorBoundary';
import {
  advanceStaticTranscriptState,
  buildStaticTranscriptState,
  type ChildHeader,
  type StaticScrollbackSource,
  type StaticTranscriptItem,
  type StaticTranscriptState,
} from './staticTranscriptRing';
import { TranscriptEntry } from './TranscriptEntry';
import { transcriptColumns } from './transcriptEntryLayout';

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
    childKind:
      child.identity?.kind === 'multiAgentWorkflow'
        ? 'workflow script'
        : 'subagent',
    positionText: ancestorPositionLabel(view, child.id),
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
  colorEnabled,
  item,
  previousItem,
  width,
}: {
  readonly colorEnabled?: boolean;
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
            colorEnabled={colorEnabled}
          />
        </EntryErrorBoundary>
      );
  }
}

export function StaticConversationTranscript({
  colorEnabled,
  maxRows,
  onRenderKeyChange,
  ownerKey,
  renderKey = ownerKey,
  scrollbackRunId,
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly maxRows?: number;
  readonly onRenderKeyChange?: () => void;
  readonly ownerKey: string;
  readonly renderKey?: string;
  readonly scrollbackRunId: RunId | undefined;
  readonly width?: number;
}): React.JSX.Element {
  const normalizedWidth = transcriptColumns(width);
  const view = useSignal(sessionView());
  const allNotices = useSignal(noticesSignal);
  const rootRunId = useSignal(rootRunIdSignal);
  const sessionMeta = useSignal(sessionMetaSignal);
  const eraseRequest = useSignal(staticTranscriptEraseEpoch);
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
      status: runPhaseOf(stream),
      waitingForChildIdentity:
        stream !== undefined &&
        stream.parentId !== null &&
        stream.identity?.kind === 'agent' &&
        stream.model === null,
      child: childHeaderFor(view, scrollbackRunId),
      hardReset:
        scrollbackRunId === undefined &&
        rootRunId === undefined &&
        allNotices.length === 0,
    };
  }, [allNotices, rootRunId, scrollbackRunId, view]);
  const [state, setState] = useState<StaticTranscriptState>(() =>
    buildStaticTranscriptState({
      eraseRequest,
      maxRows,
      meta: sessionMeta,
      ownerKey,
      repaintEpoch: 0,
      source,
      width: normalizedWidth,
    }),
  );
  // Reconcile before committing the render. Updating derived transcript state
  // in an effect commits stale rows first and schedules another React update
  // for every source change, even when only the scan position has advanced.
  const nextState = advanceStaticTranscriptState(state, {
    eraseRequest,
    maxRows,
    meta: sessionMeta,
    ownerKey,
    source,
    width: normalizedWidth,
  });
  if (nextState !== state) setState(nextState);
  const items = nextState.items;
  const repaintKey = `${renderKey}:${state.repaintEpoch}`;
  const previousRenderKey = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const previous = previousRenderKey.current;
    previousRenderKey.current = repaintKey;
    if (previous !== undefined && previous !== repaintKey) {
      onRenderKeyChange?.();
    }
  }, [onRenderKeyChange, repaintKey]);
  const staticItems = useMemo(() => [...items], [items]);
  return (
    <Static
      key={`transcript:${renderKey}:${normalizedWidth}:${state.repaintEpoch}`}
      items={staticItems}
    >
      {(item: StaticTranscriptItem, index: number) => (
        <Box key={item.id} flexDirection="column">
          <StaticTranscriptItemContent
            colorEnabled={colorEnabled}
            item={item}
            previousItem={staticItems[index - 1]}
            width={normalizedWidth}
          />
        </Box>
      )}
    </Static>
  );
}
