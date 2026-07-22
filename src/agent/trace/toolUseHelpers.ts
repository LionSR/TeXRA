/**
 * Tool-use card lifecycle helpers that work on any {@link AgentTrace}.
 *
 * The trace surface ships `toolStart` / `toolEnd` primitives that take an
 * explicit `logId`. Tool-use flows need to (1) mint a fresh id at start so
 * subsequent updates can target the same card and (2) capture the active
 * stage so a long-running tool's completion event lands under the same
 * stage as its start.
 *
 * These helpers exist so agent code can program against `AgentTrace`
 * without importing TeXRA-specific sugar (`logToolUseStart`,
 * `updateToolUse`, `emitToolUse`) — those names live alongside the other
 * helper functions but ultimately reduce to the same `toolStart` /
 * `toolEnd` emissions.
 */
import { generateShortId } from '@utils/core';

import type { AgentTrace } from './AgentTrace';
import type { ToolStatus } from './events';

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
  const groupId = stageId ?? trace.activeStageId();
  trace.toolStart({ logId, toolName, input }, { stageId: groupId });
  return { logId, groupId };
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
  ref: { logId: string; groupId?: string },
  result: unknown,
  status: ToolStatus = 'completed',
): void {
  trace.toolEnd({ logId: ref.logId, status, result }, { stageId: ref.groupId });
}

/**
 * Fast-tool variant: open AND close a card in one shot when the call is
 * already complete. Matches the legacy `emitToolUse(payload, gid)` shape
 * where `payload.status` may be terminal and `toolName` may be missing
 * (falls back to `'unknown'`, mirroring the original behavior).
 */
export function emitToolUseCard(
  trace: AgentTrace,
  payload: {
    toolName?: string;
    input?: unknown;
    status?: ToolStatus;
  } & Record<string, unknown>,
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
