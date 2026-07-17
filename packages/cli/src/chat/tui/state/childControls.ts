// Pure state helpers for App-level child execution shortcuts and pickers.

// Local imports - shared schemas
import {
  MESSAGE_TYPES,
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
} from './streamViews';
import type {
  ConversationEntry,
  ProcessOutputTail,
  StreamSlice,
} from './cliState';

const EMPTY_PROCESS_OUTPUT: ReadonlyMap<string, ProcessOutputTail> = new Map();

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

export const SUBAGENT_SUMMARY_MAX_COLUMNS = 100;

// The panel re-renders on every stream-sync tick; entries arrays are replaced
// wholesale on change, so one scan per entries version is enough. `has` (not
// the value) discriminates a cached undefined from a miss.
const childResponseSummaryCache = new WeakMap<
  readonly ConversationEntry[],
  string | undefined
>();

/**
 * Latest thing the child "said": its final model response after the newest
 * user instruction, falling back to that instruction while a turn is still
 * running. Shared by the SubagentList rows (and formerly the picker).
 */
export function latestChildResponseSummary(
  entries: readonly ConversationEntry[] | undefined,
): string | undefined {
  if (!entries) return undefined;
  if (childResponseSummaryCache.has(entries)) {
    return childResponseSummaryCache.get(entries);
  }
  const latestUserIndex = entries.findLastIndex(
    (entry) => entry.role === 'user' && entry.text.trim(),
  );
  const latestInstruction =
    latestUserIndex >= 0 ? entries[latestUserIndex]?.text : undefined;
  const summary =
    entries.findLast(
      (entry, index) =>
        index > latestUserIndex &&
        entry.role === 'assistant' &&
        entry.messageType === MESSAGE_TYPES.MODEL_RESPONSE &&
        entry.finalized &&
        entry.text.trim(),
    )?.text ?? latestInstruction;
  childResponseSummaryCache.set(entries, summary);
  return summary;
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
    const summary = latestChildResponseSummary(
      ctx.streamsById.get(child.childStreamId)?.entries,
    );
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
      // Sessions never open TaskDetailView (Enter focuses them); their
      // transcript lives in scrollback via focus.
      tailLines: EMPTY_TAIL_LINES,
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

/** Resolve the SubagentList's Enter-on-process target: the detail item for
 *  one execution id, or undefined once the process has exited. */
export function taskDetailItemForExecution({
  childStreamEntries,
  executionId,
  nowMs,
  parentStreamId,
  streams,
}: {
  readonly childStreamEntries: ChildStreamEntries;
  readonly executionId: string;
  readonly nowMs?: number;
  readonly parentStreamId: StreamTabId | undefined;
  readonly streams: ReadonlyMap<
    StreamTabId,
    Pick<
      StreamSlice,
      'activeProcesses' | 'description' | 'entries' | 'processOutput' | 'status'
    >
  >;
}): ChildControlItem | undefined {
  if (parentStreamId === undefined) return undefined;
  return buildChildControlItems(
    parentStreamId,
    childStreamEntries,
    streams,
    nowMs,
  ).find((item) => item.executionId === executionId);
}

export function hasChildControlItems(
  parentStreamId: StreamTabId | undefined,
  childStreamEntries: ChildStreamEntries,
  streams: ReadonlyMap<
    StreamTabId,
    Pick<StreamSlice, 'activeProcesses' | 'status'>
  >,
): boolean {
  if (parentStreamId === undefined) return false;
  return (
    visibleSubagentRows(parentStreamId, childStreamEntries, streams).length >
      0 || (streams.get(parentStreamId)?.activeProcesses.length ?? 0) > 0
  );
}

export function resolveChildExecutionPanelTarget({
  activeStreamId,
  childStreamEntries,
  parentStream,
  streams,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly childStreamEntries: ChildStreamEntries;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): ChildControlStreamTarget {
  const activeSlice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const activeHasRows = hasChildControlItems(
    activeStreamId,
    childStreamEntries,
    streams,
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
      hasChildControlItems(streamId, childStreamEntries, streams),
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

/** TaskDetailView key handling, kept pure for unit tests. */
export function childPickerKeyAction(key: PickerKeyInput): PickerKeyAction {
  if (isEscapeInput(key.input, key)) return { kind: 'close' };
  if (key.upArrow) return { kind: 'up' };
  if (key.downArrow) return { kind: 'down' };
  if (isPlainReturnInput(key.input, key)) return { kind: 'select' };
  if (key.input.toLowerCase() === 'k') return { kind: 'kill' };
  return { kind: 'ignore' };
}
