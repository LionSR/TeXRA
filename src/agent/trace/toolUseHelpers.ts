/**
 * Tool-use card lifecycle helpers that work on any {@link AgentTrace}.
 *
 * The trace's `tool.start` / `tool.end` events carry an explicit `logId`. Tool-use flows need to (1) mint a fresh id at start so
 * subsequent updates can target the same card and (2) capture the active
 * stage so a long-running tool's completion event lands under the same
 * stage as its start.
 *
 * These helpers exist so agent code can program against `AgentTrace`
 * without TeXRA-specific sugar; they reduce to the same `tool.start` /
 * `tool.end` emissions.
 */
import type { ToolCallStatus, ToolUseLog } from '@shared/schemas';
import { generateShortId } from '@utils/core';

import type { AgentTrace } from './AgentTrace';

export interface ToolUseCardRef {
  readonly logId: string;
  readonly groupId: string | undefined;
}

/**
 * Open a tool-use card by emitting `tool.start`. Returns the freshly
 * minted `logId` and the captured stage id so callers can correlate a
 * later `endToolUseCard` to the same card.
 */
export function startToolUseCard(
  trace: AgentTrace,
  toolName: string,
  input: unknown,
  stageId?: string,
): ToolUseCardRef {
  const logId = generateShortId();
  trace.emit({ type: 'tool.start', logId, toolName, input, stageId });
  return { logId, groupId: stageId };
}

/**
 * Emit a `tool.end` for an open card. `status` defaults to `completed`
 * (the common case), but the streaming path passes `'in_progress'` to push
 * incremental output to the same card without closing it — subscribers
 * treat a non-terminal status as a mid-flight update. The `result` patch is
 * forwarded as-is.
 */
export function endToolUseCard(
  trace: AgentTrace,
  ref: ToolUseCardRef,
  result: Omit<ToolUseLog, 'status'>,
  status: ToolCallStatus = 'completed',
): void {
  trace.emit({
    type: 'tool.end',
    logId: ref.logId,
    status,
    result,
    stageId: ref.groupId,
  });
}

/**
 * Fast-tool variant: open AND close a card in one shot when the call is
 * already complete. `payload.status` may already be terminal, and `toolName`
 * may be missing (it falls back to `'unknown'`).
 */
export function emitToolUseCard(
  trace: AgentTrace,
  payload: ToolUseLog,
  stageId?: string,
): ToolUseCardRef {
  const ref = startToolUseCard(
    trace,
    payload.toolName ?? 'unknown',
    payload.input,
    stageId,
  );
  if (payload.status && payload.status !== 'in_progress') {
    endToolUseCard(trace, ref, payload, payload.status);
  }
  return ref;
}

/** A card its caller holds open, with the log it last showed. */
export type OpenToolUseCard = ToolUseCardRef & { readonly toolLog: ToolUseLog };

/** End every card still open as failed, keeping what each last showed: a
 *  turn that ended before its tools reported leaves no card running. */
export function endOpenToolUseCards(
  trace: AgentTrace,
  cards: Map<string, OpenToolUseCard>,
): void {
  for (const { toolLog, ...ref } of cards.values()) {
    const { status: _status, ...log } = toolLog;
    const error = 'The turn ended before this tool reported.';
    endToolUseCard(trace, ref, { ...log, error }, 'failed');
  }
  cards.clear();
}
