import { AgentLogger } from '@logger/AgentLogger';
import type { ActiveChildInfo, StreamTabId } from '@shared/schemas';

import type {
  CompletedProcessTranscript,
  ConversationEntry,
  ProcessOutputTail,
  StreamSlice,
} from './cliState';

export const COMPLETED_PROCESS_TAIL_LINES = 20;

function processTitle(info: ActiveChildInfo): string {
  return info.agentName || info.toolName || info.executionId;
}

export function isCompletedProcessError(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return false;
  if (
    normalized === 'error' ||
    normalized === 'failed' ||
    normalized === 'stopped'
  ) {
    return true;
  }
  if (/exit(?:ed)?(?:\s+with)?(?:\s+code)?\s+[1-9]\d*/.test(normalized)) {
    return true;
  }
  return false;
}

function completedProcessStatus(status: string | undefined): string {
  const normalized = status?.trim().toLowerCase();
  if (
    !normalized ||
    normalized === 'initializing' ||
    normalized === 'resuming' ||
    normalized === 'running' ||
    normalized === 'waiting'
  ) {
    return 'completed';
  }
  return status ?? 'completed';
}

export function completedProcessTailLines(
  tail: ProcessOutputTail | undefined,
): string[] {
  if (!tail) return [];
  return `${tail.stdout}\n${tail.stderr}`
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-COMPLETED_PROCESS_TAIL_LINES);
}

export function buildCompletedProcessTranscript(
  info: ActiveChildInfo,
  tail: ProcessOutputTail | undefined,
): CompletedProcessTranscript {
  const status = completedProcessStatus(info.status);
  return {
    executionId: info.executionId,
    title: processTitle(info),
    status,
    elapsed: info.elapsed,
    isError: isCompletedProcessError(status),
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
      const prefix = index === 0 ? '⎿ ' : '  ';
      return `${prefix}${line}`;
    }),
  ];
}

export function buildCompletedProcessEntry(params: {
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
      AgentLogger.getStreamLogStore().get(params.streamId)?.head ?? 0,
  };
}

export function appendCompletedProcessEntries(
  streamId: StreamTabId,
  slice: StreamSlice,
  liveExecutionIds: ReadonlySet<string>,
): ConversationEntry[] {
  const next = [...slice.entries];
  const existingIds = new Set(next.map((entry) => entry.id));
  for (const info of slice.activeProcesses) {
    if (liveExecutionIds.has(info.executionId)) continue;
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
