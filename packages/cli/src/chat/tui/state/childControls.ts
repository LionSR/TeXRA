// Pure state helpers for App-level child execution shortcuts and pickers.

// Local imports - shared schemas
import {
  STREAM_PHASE,
  type ActiveChildInfo,
  type StreamTabId,
  type SubagentChildInfo,
} from '@shared/schemas';
import { formatStreamStatusLabel } from '@shared/streams/streamStatusDisplay';
import { formatCompactDuration } from '@utils/core';

// Local imports - CLI state
import { isEscapeInput, isPlainReturnInput } from '../input/inputKeys';
import { truncateSummaryToWidth } from '../render/terminalText';
import {
  activeSubagentsFor,
  childExecutionKey,
  childExecutionLabel,
  visibleSubagentRows,
  type ChildStreamEntries,
} from './childExecutions';
import {
  activeStreamTreeEntries,
  nearestActiveStreamAncestor,
  streamDisplayLabel,
} from './streamViews';
import { transcriptEntryLines } from './transcriptLines';
import type {
  ConversationEntry,
  ProcessOutputTail,
  StreamSlice,
} from './cliState';

const EMPTY_PROCESS_OUTPUT: ReadonlyMap<string, ProcessOutputTail> = new Map();

export type ChildControlMode = 'subagents' | 'tasks';

export const CHILD_CONTROL_MODE_COPY = {
  subagents: {
    emptyText: 'No active subagents.',
    missingItemsText: 'has no subagents',
    title: 'Subagents',
  },
  tasks: {
    emptyText: 'No active tasks or sub-workflows.',
    missingItemsText: 'has no tasks or sub-workflows',
    title: 'Tasks and sub-workflows',
  },
} as const satisfies Record<
  ChildControlMode,
  {
    readonly emptyText: string;
    readonly missingItemsText: string;
    readonly title: string;
  }
>;

export interface ChildControlItem {
  readonly executionId: string;
  readonly childStreamId?: StreamTabId;
  readonly kind: 'process' | 'subagent';
  readonly label: string;
  readonly command: string;
  readonly description: string;
  readonly statusLabel?: string;
  readonly elapsed?: string | null;
  readonly killable: boolean;
  readonly tailLines: readonly string[];
}

export interface ChildControlStreamTarget {
  readonly fallbackFromStreamId?: StreamTabId;
  readonly hasItems: boolean;
  readonly slice: StreamSlice | undefined;
  readonly streamId: StreamTabId | undefined;
}

interface ChildControlDisplayTarget extends ChildControlStreamTarget {
  readonly streamLabel: string | undefined;
  readonly streamScopeDetail: string | undefined;
}

export type ChildControlDisplayTargets = Record<
  ChildControlMode,
  ChildControlDisplayTarget
>;

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

function childStatusDescription(
  status: string | undefined,
): string | undefined {
  // Every picker/detail row here is a child/subagent stream, never the root
  // session, so WAITING always gets the distinct child-waiting wording.
  return formatStreamStatusLabel(status, {
    style: 'cliCompact',
    isChildStream: true,
  });
}

function hasLiveChildElapsed(
  child: Pick<ActiveChildInfo, 'startedAt' | 'status'>,
): boolean {
  return (
    child.startedAt !== undefined &&
    (child.status === undefined || child.status === STREAM_PHASE.RUNNING)
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
  return formatCompactDuration(nowMs - startedAt);
}

function streamDescription(
  child: SubagentChildInfo,
  streamsById: ReadonlyMap<StreamTabId, Pick<StreamSlice, 'description'>>,
): string | undefined {
  return streamsById.get(child.childStreamId)?.description;
}

const SUBAGENT_SUMMARY_MAX_COLUMNS = 100;

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
  child: SubagentChildInfo,
  streamsById: ReadonlyMap<StreamTabId, Pick<StreamSlice, 'entries'>>,
): readonly string[] {
  const stream = streamsById.get(child.childStreamId);
  if (!stream) return [];
  return stream.entries.flatMap((entry) =>
    streamEntryTailLines(entry).filter((line) => line.trim().length > 0),
  );
}

/**
 * Build a picker/detail row for either a subagent or a process badge. The two
 * kinds share the same `ChildControlItem` output shape and most of the
 * derivation logic (label, elapsed, status), so they're built by one function
 * switching on `child.kind` — the two remaining differences are genuine, not
 * artifacts of a shared-but-undiscriminated input type: a subagent's tail
 * comes from its own stream's transcript (looked up by `childStreamId`),
 * while a process's tail comes from its captured stdout/stderr, and only
 * subagents can be individually non-killable (already-detached rows).
 */
function buildChildControlItem(
  child: ActiveChildInfo,
  ctx: {
    readonly streamsById: ReadonlyMap<
      StreamTabId,
      Pick<StreamSlice, 'description' | 'entries'>
    >;
    readonly processOutput: ReadonlyMap<string, ProcessOutputTail>;
    readonly killable: boolean;
    readonly nowMs?: number;
  },
): ChildControlItem {
  const label = childExecutionLabel(child);
  const elapsed = childElapsed(child, ctx.nowMs);
  const statusLabel = childStatusDescription(child.status);

  if (child.kind === 'subagent') {
    const entries = ctx.streamsById.get(child.childStreamId)?.entries;
    const summary =
      entries?.findLast(
        (entry) =>
          entry.role === 'assistant' && entry.finalized && entry.text.trim(),
      )?.text ??
      entries?.find((entry) => entry.role === 'user' && entry.text.trim())
        ?.text;
    return {
      executionId: child.executionId,
      childStreamId: child.childStreamId,
      kind: 'subagent',
      label,
      command: streamDescription(child, ctx.streamsById) ?? label,
      description: compactParts([
        statusLabel,
        elapsed ?? undefined,
        summary
          ? truncateSummaryToWidth(summary, SUBAGENT_SUMMARY_MAX_COLUMNS)
          : undefined,
      ]),
      statusLabel,
      elapsed,
      killable: ctx.killable,
      tailLines: streamTranscriptLines(child, ctx.streamsById),
    };
  }

  const tailLines = processTailLines(ctx.processOutput.get(child.executionId));
  return {
    executionId: child.executionId,
    kind: 'process',
    label,
    command: label,
    description: compactParts([
      statusLabel,
      elapsed ?? undefined,
      tailLines.at(-1),
    ]),
    statusLabel,
    elapsed,
    killable: true,
    tailLines,
  };
}

const EMPTY_TAIL_LINES: readonly string[] = [];
// Tail objects are immutable and replaced wholesale by updateProcessOutput,
// so the split is cached per object: the subagent panel re-renders on every
// stream-sync tick and would otherwise re-split up to 16 KB per process row.
const processTailLinesCache = new WeakMap<
  ProcessOutputTail,
  readonly string[]
>();

export function processTailLines(
  tail: ProcessOutputTail | undefined,
): readonly string[] {
  if (!tail) return EMPTY_TAIL_LINES;
  const cached = processTailLinesCache.get(tail);
  if (cached) return cached;
  const lines = `${tail.stdout}\n${tail.stderr}`
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  processTailLinesCache.set(tail, lines);
  return lines;
}

export function buildChildControlItems(
  parentStreamId: StreamTabId,
  childStreamEntries: ChildStreamEntries,
  streams: ReadonlyMap<
    StreamTabId,
    Pick<
      StreamSlice,
      'activeProcesses' | 'description' | 'entries' | 'processOutput' | 'status'
    >
  >,
  mode: ChildControlMode,
  nowMs?: number,
): readonly ChildControlItem[] {
  const parentSlice = streams.get(parentStreamId);
  const activeProcesses = parentSlice?.activeProcesses ?? [];
  const processOutput = parentSlice?.processOutput ?? EMPTY_PROCESS_OUTPUT;
  const activeKeys = new Set(
    activeSubagentsFor(parentStreamId, childStreamEntries, streams).map(
      childExecutionKey,
    ),
  );
  const subagentItems = visibleSubagentRows(
    parentStreamId,
    childStreamEntries,
    streams,
  ).map((child) =>
    buildChildControlItem(child, {
      streamsById: streams,
      processOutput,
      nowMs,
      killable: activeKeys.has(childExecutionKey(child)),
    }),
  );
  if (mode === 'subagents') {
    return subagentItems;
  }

  return [
    ...subagentItems,
    ...activeProcesses.map((child) =>
      buildChildControlItem(child, {
        streamsById: streams,
        processOutput,
        nowMs,
        killable: true,
      }),
    ),
  ];
}

export function hasChildControlItems(
  parentStreamId: StreamTabId | undefined,
  childStreamEntries: ChildStreamEntries,
  streams: ReadonlyMap<
    StreamTabId,
    Pick<StreamSlice, 'activeProcesses' | 'status'>
  >,
  mode: ChildControlMode,
): boolean {
  if (parentStreamId === undefined) return false;
  if (mode === 'subagents') {
    return (
      visibleSubagentRows(parentStreamId, childStreamEntries, streams).length >
      0
    );
  }
  return (
    visibleSubagentRows(parentStreamId, childStreamEntries, streams).length >
      0 || (streams.get(parentStreamId)?.activeProcesses.length ?? 0) > 0
  );
}

export function resolveChildControlStreamTarget({
  activeStreamId,
  childStreamEntries,
  mode,
  parentStream,
  streams,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly childStreamEntries: ChildStreamEntries;
  readonly mode: ChildControlMode;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): ChildControlStreamTarget {
  const activeSlice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const activeHasRows = hasChildControlItems(
    activeStreamId,
    childStreamEntries,
    streams,
    mode,
  );
  if (!activeStreamId || activeHasRows) {
    return {
      hasItems: activeHasRows,
      streamId: activeStreamId,
      slice: activeSlice,
    };
  }

  const ancestor = nearestActiveStreamAncestor({
    activeStreamId,
    parentStream,
    values: streams,
    canUseValue: (_slice, streamId) =>
      hasChildControlItems(streamId, childStreamEntries, streams, mode),
  });
  if (ancestor) {
    return {
      fallbackFromStreamId: activeStreamId,
      hasItems: true,
      streamId: ancestor.streamId,
      slice: ancestor.value,
    };
  }

  return {
    hasItems: false,
    streamId: activeStreamId,
    slice: activeSlice,
  };
}

function childControlFallbackDetail(
  mode: ChildControlMode,
  fallbackFromStreamLabel: string | undefined,
  targetStreamLabel: string | undefined,
): string | undefined {
  if (!fallbackFromStreamLabel || !targetStreamLabel) return undefined;
  return `${fallbackFromStreamLabel} ${CHILD_CONTROL_MODE_COPY[mode].missingItemsText}`;
}

function resolveChildControlDisplayTarget({
  activeStreamId,
  childStreamEntries,
  mode,
  parentStream,
  streams,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly childStreamEntries: ChildStreamEntries;
  readonly mode: ChildControlMode;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): ChildControlDisplayTarget {
  const target = resolveChildControlStreamTarget({
    activeStreamId,
    childStreamEntries,
    mode,
    parentStream,
    streams,
  });
  const streamLabel = target.streamId
    ? streamDisplayLabel({
        childStreamEntries,
        parentStream,
        streamId: target.streamId,
        streams,
      })
    : undefined;
  const fallbackFromStreamLabel = target.fallbackFromStreamId
    ? streamDisplayLabel({
        childStreamEntries,
        parentStream,
        streamId: target.fallbackFromStreamId,
        streams,
      })
    : undefined;
  return {
    ...target,
    streamLabel,
    streamScopeDetail: childControlFallbackDetail(
      mode,
      fallbackFromStreamLabel,
      streamLabel,
    ),
  };
}

export function resolveChildControlDisplayTargets({
  activeStreamId,
  childStreamEntries,
  parentStream,
  streams,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly childStreamEntries: ChildStreamEntries;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): ChildControlDisplayTargets {
  return {
    subagents: resolveChildControlDisplayTarget({
      activeStreamId,
      childStreamEntries,
      mode: 'subagents',
      parentStream,
      streams,
    }),
    tasks: resolveChildControlDisplayTarget({
      activeStreamId,
      childStreamEntries,
      mode: 'tasks',
      parentStream,
      streams,
    }),
  };
}

export function liveChildExecutionElapsedKey(
  activeSubagents: readonly ActiveChildInfo[],
  activeProcesses: readonly ActiveChildInfo[],
): string | undefined {
  const liveKeys = [...activeSubagents, ...activeProcesses]
    .filter(hasLiveChildElapsed)
    .map((child) => `${child.executionId}:${child.startedAt}`)
    .sort();
  return liveKeys.length > 0 ? liveKeys.join(',') : undefined;
}

export function numericFocusTargetForActiveStream(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly childStreamEntries: ChildStreamEntries;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly zeroBasedIndex: number;
}): StreamTabId | undefined {
  if (!init.activeStreamId || init.zeroBasedIndex < 0) return undefined;
  const shortcutIndex = init.zeroBasedIndex + 1;
  return activeStreamTreeEntries({
    activeStreamId: init.activeStreamId,
    childStreamEntries: init.childStreamEntries,
    parentStream: init.parentStream,
    streams: init.streams,
  }).find((entry) => entry.shortcutIndex === shortcutIndex)?.id;
}

export type SubagentPickerSelection =
  | { readonly kind: 'view'; readonly streamId: StreamTabId }
  | { readonly kind: 'detail'; readonly executionId: string };

/** What pressing Enter on a child-control row should do. In subagents mode a
 *  row backed by a child stream opens that subagent's transcript viewer
 *  (its independent history); everything else (tasks/processes, or a
 *  stream-less row) drops into the inline tail detail view. Pure so the
 *  picker's key handling stays unit-testable. */
export function subagentPickerSelection(
  mode: ChildControlMode,
  item: Pick<ChildControlItem, 'childStreamId' | 'executionId'> | undefined,
): SubagentPickerSelection | undefined {
  if (!item) return undefined;
  if (mode === 'subagents' && item.childStreamId) {
    return { kind: 'view', streamId: item.childStreamId };
  }
  return { kind: 'detail', executionId: item.executionId };
}

export function childPickerKeyAction(key: PickerKeyInput): PickerKeyAction {
  if (isEscapeInput(key.input, key)) return { kind: 'close' };
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
