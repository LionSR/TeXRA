// Pure state helpers for App-level child execution shortcuts and pickers.

// Local imports - shared schemas
import {
  LIVE_ELAPSED_STREAM_STATUSES,
  STREAM_STATUS,
  type ActiveChildInfo,
  type StreamTabId,
} from '@shared/schemas';
import { formatDuration } from '@utils/core';

// Local imports - CLI state
import { isPlainReturnInput } from '../input/inputKeys';
import { visibleSubagentRows } from './childStreamMerge';
import { orderedDescendantsFromTree } from './focusCycle';
import { transcriptEntryLines } from './transcriptLines';
import type {
  ConversationEntry,
  ProcessOutputTail,
  StreamSlice,
} from './cliState';

export type ChildControlMode = 'subagents' | 'tasks';

export interface ChildControlItem {
  readonly executionId: string;
  readonly childStreamId?: StreamTabId;
  readonly kind: 'process' | 'subagent';
  readonly label: string;
  readonly command: string;
  readonly description: string;
  readonly status?: string;
  readonly elapsed?: string | null;
  readonly killable: boolean;
  readonly tailLines: readonly string[];
}

export interface ChildControlStreamTarget {
  readonly fallbackFromStreamId?: StreamTabId;
  readonly slice: StreamSlice | undefined;
  readonly streamId: StreamTabId | undefined;
}

export interface PickerKeyInput {
  readonly input: string;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
}

export type PickerKeyAction =
  | { readonly kind: 'close' }
  | { readonly kind: 'down' }
  | { readonly kind: 'ignore' }
  | { readonly kind: 'jump'; readonly index: number }
  | { readonly kind: 'kill' }
  | { readonly kind: 'select' }
  | { readonly kind: 'up' };

function compactParts(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(' · ');
}

function hasLiveChildElapsed(
  child: Pick<ActiveChildInfo, 'startedAt' | 'status'>,
): boolean {
  return (
    child.startedAt !== undefined &&
    LIVE_ELAPSED_STREAM_STATUSES.has(child.status ?? STREAM_STATUS.RUNNING)
  );
}

export function childElapsed(
  child: Pick<ActiveChildInfo, 'elapsed' | 'startedAt' | 'status'>,
  nowMs = Date.now(),
): string | null | undefined {
  const startedAt = child.startedAt;
  if (startedAt === undefined || !hasLiveChildElapsed(child)) {
    return child.elapsed;
  }
  return formatDuration(Math.max(0, nowMs - startedAt));
}

function childLabel(child: {
  readonly agentName?: string;
  readonly toolName?: string;
  readonly executionId: string;
}): string {
  return child.agentName || child.toolName || child.executionId;
}

function childKey(
  child: Pick<ActiveChildInfo, 'childStreamId' | 'executionId'>,
): string {
  return child.childStreamId ?? child.executionId;
}

function streamDescription(
  child: Pick<ActiveChildInfo, 'childStreamId'>,
  streamsById: ReadonlyMap<StreamTabId, Pick<StreamSlice, 'description'>>,
): string | undefined {
  return child.childStreamId
    ? streamsById.get(child.childStreamId)?.description
    : undefined;
}

const TASK_DETAIL_TRANSCRIPT_COLUMNS = 120;

function streamEntryTailLines(entry: ConversationEntry): readonly string[] {
  if (entry.role === 'tool' || entry.role === 'process') {
    return transcriptEntryLines(entry, TASK_DETAIL_TRANSCRIPT_COLUMNS);
  }
  return entry.text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function streamTranscriptLines(
  child: Pick<ActiveChildInfo, 'childStreamId'>,
  streamsById: ReadonlyMap<StreamTabId, Pick<StreamSlice, 'entries'>>,
): readonly string[] {
  if (!child.childStreamId) return [];
  const stream = streamsById.get(child.childStreamId);
  if (!stream) return [];
  return stream.entries.flatMap((entry) =>
    streamEntryTailLines(entry).filter((line) => line.trim().length > 0),
  );
}

function buildSubagentItem(
  child: ActiveChildInfo,
  streamsById: ReadonlyMap<
    StreamTabId,
    Pick<StreamSlice, 'description' | 'entries'>
  >,
  nowMs?: number,
  killable = true,
): ChildControlItem {
  const label = childLabel(child);
  const command = streamDescription(child, streamsById) ?? label;
  const elapsed = childElapsed(child, nowMs);
  return {
    executionId: child.executionId,
    childStreamId: child.childStreamId,
    kind: 'subagent',
    label,
    command,
    description: compactParts([child.status, elapsed ?? undefined]),
    status: child.status,
    elapsed,
    killable,
    tailLines: streamTranscriptLines(child, streamsById),
  };
}

function buildProcessItem(
  child: ActiveChildInfo,
  tail: ProcessOutputTail | undefined,
  nowMs?: number,
): ChildControlItem {
  const tailLines = processTailLines(tail);
  const lastLine = tailLines.at(-1);
  const label = childLabel(child);
  const elapsed = childElapsed(child, nowMs);
  return {
    executionId: child.executionId,
    childStreamId: child.childStreamId,
    kind: 'process',
    label,
    command: label,
    description: compactParts([child.status, elapsed ?? undefined, lastLine]),
    status: child.status,
    elapsed,
    killable: true,
    tailLines,
  };
}

export function processTailLines(
  tail: ProcessOutputTail | undefined,
): readonly string[] {
  if (!tail) return [];
  return `${tail.stdout}\n${tail.stderr}`
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export function buildChildControlItems(
  slice: Pick<
    StreamSlice,
    'activeProcesses' | 'activeSubagents' | 'childStreams' | 'processOutput'
  >,
  mode: ChildControlMode,
  streamsById: ReadonlyMap<
    StreamTabId,
    Pick<StreamSlice, 'description' | 'entries'>
  > = new Map(),
  nowMs?: number,
): readonly ChildControlItem[] {
  if (mode === 'subagents') {
    const activeKeys = new Set(slice.activeSubagents.map(childKey));
    return visibleSubagentRows(slice).map((child) =>
      buildSubagentItem(
        child,
        streamsById,
        nowMs,
        activeKeys.has(childKey(child)),
      ),
    );
  }

  return [
    ...slice.activeSubagents.map((child) =>
      buildSubagentItem(child, streamsById, nowMs),
    ),
    ...slice.activeProcesses.map((child) =>
      buildProcessItem(
        child,
        slice.processOutput.get(child.executionId),
        nowMs,
      ),
    ),
  ];
}

function hasVisibleSubagents(
  slice: Pick<StreamSlice, 'activeSubagents' | 'childStreams'> | undefined,
): boolean {
  return slice !== undefined && visibleSubagentRows(slice).length > 0;
}

function hasVisibleTasks(
  slice: Pick<StreamSlice, 'activeProcesses' | 'activeSubagents'> | undefined,
): boolean {
  return (
    slice !== undefined &&
    (slice.activeSubagents.length > 0 || slice.activeProcesses.length > 0)
  );
}

export function hasChildControlItems(
  slice:
    | Pick<StreamSlice, 'activeProcesses' | 'activeSubagents' | 'childStreams'>
    | undefined,
  mode: ChildControlMode,
): boolean {
  return mode === 'subagents'
    ? hasVisibleSubagents(slice)
    : hasVisibleTasks(slice);
}

export function resolveChildControlStreamTarget({
  activeStreamId,
  mode,
  parentStream,
  streams,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly mode: ChildControlMode;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): ChildControlStreamTarget {
  const activeSlice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const activeHasRows =
    mode === 'subagents'
      ? hasVisibleSubagents(activeSlice)
      : hasVisibleTasks(activeSlice);
  if (!activeStreamId || activeHasRows) {
    return { streamId: activeStreamId, slice: activeSlice };
  }

  const parentStreamId = parentStream.get(activeStreamId);
  const parentSlice = parentStreamId ? streams.get(parentStreamId) : undefined;
  const parentHasRows =
    mode === 'subagents'
      ? hasVisibleSubagents(parentSlice)
      : hasVisibleTasks(parentSlice);
  if (parentHasRows) {
    return {
      fallbackFromStreamId: activeStreamId,
      streamId: parentStreamId,
      slice: parentSlice,
    };
  }

  return { streamId: activeStreamId, slice: activeSlice };
}

export function liveChildExecutionElapsedKey(
  slice: Pick<StreamSlice, 'activeProcesses' | 'activeSubagents'> | undefined,
): string | undefined {
  if (slice === undefined) return undefined;

  const liveKeys: string[] = [];
  for (const child of slice.activeSubagents) {
    if (hasLiveChildElapsed(child)) {
      liveKeys.push(`${child.executionId}:${child.startedAt}`);
    }
  }
  for (const child of slice.activeProcesses) {
    if (hasLiveChildElapsed(child)) {
      liveKeys.push(`${child.executionId}:${child.startedAt}`);
    }
  }
  liveKeys.sort();
  return liveKeys.length > 0 ? liveKeys.join(',') : undefined;
}

export function hasChildExecutionRows(
  slice:
    | Pick<StreamSlice, 'activeProcesses' | 'activeSubagents' | 'childStreams'>
    | undefined,
): boolean {
  return (
    slice !== undefined &&
    (visibleSubagentRows(slice).length > 0 || slice.activeProcesses.length > 0)
  );
}

export function numericFocusTargetForActiveStream(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly zeroBasedIndex: number;
}): StreamTabId | undefined {
  if (!init.activeStreamId || init.zeroBasedIndex < 0) return undefined;
  const root =
    init.parentStream.get(init.activeStreamId) ?? init.activeStreamId;
  return orderedDescendantsFromTree({
    parent: root,
    parentSlice: init.streams.get(root),
    parentStream: init.parentStream,
    streams: init.streams,
  })[init.zeroBasedIndex];
}

export function clampPickerIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

export function nextPickerIndex(
  index: number,
  length: number,
  direction: 'down' | 'up',
): number {
  if (length <= 0) return 0;
  if (direction === 'up') {
    return index <= 0 ? length - 1 : index - 1;
  }
  return (index + 1) % length;
}

export function childPickerKeyAction(key: PickerKeyInput): PickerKeyAction {
  if (key.escape) return { kind: 'close' };
  if (key.upArrow) return { kind: 'up' };
  if (key.downArrow) return { kind: 'down' };
  if (isPlainReturnInput(key.input, key)) return { kind: 'select' };
  if (key.input.toLowerCase() === 'k') return { kind: 'kill' };

  const digit = Number(key.input);
  if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
    return { kind: 'jump', index: digit - 1 };
  }
  return { kind: 'ignore' };
}
