import type { StreamTabId } from '@shared/schemas/identifiers';

import { OdysseyStore, isOdysseyEnabled } from '@tools/odyssey';

import { buildContinuationFollowUp } from './buildContinuationFollowUp';

export interface OdysseyContinuationContext {
  streamId: StreamTabId;
  /** True when the current wait-node is running inside an orchestrator-driven subagent. */
  isSubagent: boolean;
  /** Result of `session.hasQueuedFollowUp()` at the call site. */
  hasQueuedFollowUp: boolean;
}

/**
 * Pre-wait Odyssey continuation check.
 *
 * Returns a rendered continuation prompt when:
 *   - the feature flag is on,
 *   - the current node is NOT a subagent (parent orchestrator owns continuation
 *     — subagents only ever roll their usage up to the parent, never drive the
 *     loop),
 *   - no user followUp is already queued (caller-supplied snapshot),
 *   - the stream has an Odyssey with status `active`.
 *
 * Returns null in every other case so the caller falls back to the normal
 * blocking wait. Pure: no side effects. The autonomous loop runs until the
 * model finishes (`plan(command="complete")` → forget) or the user stops it;
 * there is no continuation counter or per-turn cap.
 *
 * Called from `ToolUseWaitNode.exec()` BEFORE `session.waitForFollowUp` — the
 * wait blocks indefinitely on an empty queue, so the continuation cannot run
 * after it.
 */
export async function maybeBuildOdysseyContinuation(
  ctx: OdysseyContinuationContext,
): Promise<string | null> {
  if (ctx.isSubagent) return null;
  if (ctx.hasQueuedFollowUp) return null;

  // Read the store first — it is bootstrap-tolerant (returns null before
  // platform init), so the flag check below (which needs `platform()`) is only
  // reached when an active record actually exists on disk.
  const odyssey = OdysseyStore.getForStream(ctx.streamId);
  if (!odyssey || odyssey.status !== 'active') return null;

  if (!isOdysseyEnabled()) return null;

  return buildContinuationFollowUp(odyssey);
}
