// Pure state helpers for App-level child execution shortcuts and pickers.

// Local imports - shared schemas
import type { ActiveChildInfo, StreamTabId } from '@shared/schemas';

// Local imports - CLI state
import { isPlainReturnInput } from '../input/inputKeys';
import { mergeChildStreams } from './childStreamMerge';
import { orderedDescendantsFromSlice } from './focusCycle';
import type { ProcessOutputTail, StreamSlice } from './cliState';

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
  readonly tailLines: readonly string[];
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

function childLabel(child: {
  readonly agentName?: string;
  readonly toolName?: string;
  readonly executionId: string;
}): string {
  return child.agentName || child.toolName || child.executionId;
}

function streamDescription(
  child: Pick<ActiveChildInfo, 'childStreamId'>,
  streamsById: ReadonlyMap<StreamTabId, Pick<StreamSlice, 'description'>>,
): string | undefined {
  return child.childStreamId
    ? streamsById.get(child.childStreamId)?.description
    : undefined;
}

function streamTranscriptLines(
  child: Pick<ActiveChildInfo, 'childStreamId'>,
  streamsById: ReadonlyMap<StreamTabId, Pick<StreamSlice, 'entries'>>,
): readonly string[] {
  if (!child.childStreamId) return [];
  const stream = streamsById.get(child.childStreamId);
  if (!stream) return [];
  return stream.entries.flatMap((entry) =>
    entry.text
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0),
  );
}

function buildSubagentItem(
  child: ActiveChildInfo,
  streamsById: ReadonlyMap<
    StreamTabId,
    Pick<StreamSlice, 'description' | 'entries'>
  >,
): ChildControlItem {
  const label = childLabel(child);
  const command = streamDescription(child, streamsById) ?? label;
  return {
    executionId: child.executionId,
    childStreamId: child.childStreamId,
    kind: 'subagent',
    label,
    command,
    description: compactParts([child.status, child.elapsed ?? undefined]),
    status: child.status,
    elapsed: child.elapsed,
    tailLines: streamTranscriptLines(child, streamsById),
  };
}

function buildProcessItem(
  child: ActiveChildInfo,
  tail: ProcessOutputTail | undefined,
): ChildControlItem {
  const tailLines = processTailLines(tail);
  const lastLine = tailLines.at(-1);
  const label = childLabel(child);
  return {
    executionId: child.executionId,
    childStreamId: child.childStreamId,
    kind: 'process',
    label,
    command: label,
    description: compactParts([
      child.status,
      child.elapsed ?? undefined,
      lastLine,
    ]),
    status: child.status,
    elapsed: child.elapsed,
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
): readonly ChildControlItem[] {
  if (mode === 'subagents') {
    return mergeChildStreams(slice.childStreams, slice.activeSubagents).map(
      (child) => buildSubagentItem(child, streamsById),
    );
  }

  return [
    ...slice.activeSubagents.map((child) =>
      buildSubagentItem(child, streamsById),
    ),
    ...slice.activeProcesses.map((child) =>
      buildProcessItem(child, slice.processOutput.get(child.executionId)),
    ),
  ];
}

export function numericFocusTarget(
  slice:
    | Pick<StreamSlice, 'activeProcesses' | 'activeSubagents' | 'childStreams'>
    | undefined,
  zeroBasedIndex: number,
): StreamTabId | undefined {
  if (!slice || zeroBasedIndex < 0) return undefined;
  return orderedDescendantsFromSlice(slice)[zeroBasedIndex];
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
