// Pure state helpers for App-level child execution shortcuts and pickers.

// Local imports - shared schemas
import type { StreamTabId } from '@shared/schemas';

// Local imports - CLI state
import { orderedDescendantsFromSlice } from './focusCycle';
import type { ProcessOutputTail, StreamSlice } from './cliState';

export type ChildControlMode = 'processes' | 'subagents';

export interface ChildControlItem {
  readonly executionId: string;
  readonly childStreamId?: StreamTabId;
  readonly label: string;
  readonly description: string;
  readonly tailLines: readonly string[];
}

export interface PickerKeyInput {
  readonly input: string;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
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
    'activeProcesses' | 'activeSubagents' | 'processOutput'
  >,
  mode: ChildControlMode,
): readonly ChildControlItem[] {
  if (mode === 'subagents') {
    return slice.activeSubagents.map((child) => ({
      executionId: child.executionId,
      childStreamId: child.childStreamId,
      label: childLabel(child),
      description: compactParts([child.status, child.elapsed ?? undefined]),
      tailLines: [],
    }));
  }

  return slice.activeProcesses.map((child) => {
    const tailLines = processTailLines(
      slice.processOutput.get(child.executionId),
    );
    const lastLine = tailLines.at(-1);
    return {
      executionId: child.executionId,
      childStreamId: child.childStreamId,
      label: childLabel(child),
      description: compactParts([
        child.status,
        child.elapsed ?? undefined,
        lastLine,
      ]),
      tailLines,
    };
  });
}

export function numericFocusTarget(
  slice: Pick<StreamSlice, 'activeProcesses' | 'activeSubagents'> | undefined,
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
  if (key.return) return { kind: 'select' };
  if (key.input.toLowerCase() === 'k') return { kind: 'kill' };

  const digit = Number(key.input);
  if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
    return { kind: 'jump', index: digit - 1 };
  }
  return { kind: 'ignore' };
}
