import { defaultSession } from '@agent/runtime/SessionHandle';
import type { ActiveChildInfo, StreamTabId } from '@shared/schemas';

import {
  completedChildExecutionStatus,
  isChildExecutionErrorStatus,
} from './childExecutionStatus';
import { processTailLines } from './childControls';
import { childExecutionLabel } from './childExecutions';
import { TOOL_OUTPUT_CORNER } from '../ui/glyphs';
import type {
  CompletedProcessTranscript,
  ConversationEntry,
  ProcessOutputTail,
  StreamSlice,
} from './cliState';

export const COMPLETED_PROCESS_TAIL_LINES = 20;

function completedProcessTailLines(
  tail: ProcessOutputTail | undefined,
): readonly string[] {
  return processTailLines(tail).slice(-COMPLETED_PROCESS_TAIL_LINES);
}

export function buildCompletedProcessTranscript(
  info: ActiveChildInfo,
  tail: ProcessOutputTail | undefined,
): CompletedProcessTranscript {
  const status = completedChildExecutionStatus(info.status);
  return {
    executionId: info.executionId,
    title: childExecutionLabel(info),
    status,
    elapsed: info.elapsed,
    isError: isChildExecutionErrorStatus(status),
    tailLines: completedProcessTailLines(tail),
  };
}

export function completedProcessDisplayLines(
  process: CompletedProcessTranscript,
): string[] {
  const status = [
    process.status,
    process.elapsed,
    process.isError ? 'error' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const header = status ? `${process.title} · ${status}` : process.title;
  return [
    header,
    ...process.tailLines.map((line, index) => {
      const prefix = index === 0 ? `${TOOL_OUTPUT_CORNER} ` : '  ';
      return `${prefix}${line}`;
    }),
  ];
}

function buildCompletedProcessEntry(params: {
  readonly streamId: StreamTabId;
  readonly info: ActiveChildInfo;
  readonly tail: ProcessOutputTail | undefined;
}): ConversationEntry {
  const process = buildCompletedProcessTranscript(params.info, params.tail);
  return {
    id: `process:${params.streamId}:${params.info.executionId}`,
    role: 'process',
    text: '',
    finalized: true,
    process,
    synthetic: true,
    syntheticKind: 'process',
    syntheticAfterSeq:
      defaultSession().transcripts.get(params.streamId)?.head ?? 0,
    syntheticAfterSettlementSeqNo:
      defaultSession().transcripts.get(params.streamId)?.settlementHead ?? 0,
  };
}

export function appendCompletedProcessEntries(
  streamId: StreamTabId,
  slice: StreamSlice,
  vanishedExecutionIds: ReadonlySet<string>,
): ConversationEntry[] {
  const next = [...slice.entries];
  const existingIds = new Set(next.map((entry) => entry.id));
  for (const info of slice.activeProcesses) {
    if (!vanishedExecutionIds.has(info.executionId)) continue;
    const entry = buildCompletedProcessEntry({
      streamId,
      info,
      tail: slice.processOutput.get(info.executionId),
    });
    if (existingIds.has(entry.id)) continue;
    existingIds.add(entry.id);
    next.push(entry);
  }
  return next;
}
