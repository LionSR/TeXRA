import { platform } from '@platform/platform';
import type { StreamTabId } from '@shared/schemas/identifiers';

import { ODYSSEY_FEATURE_FLAG_KEY, OdysseyStore } from '@tools/odyssey';

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
 *   - the current node is NOT a subagent (parent orchestrator owns continuation),
 *   - no user followUp is already queued (caller-supplied snapshot),
 *   - the stream has an Odyssey with status `active`.
 *
 * Returns null in every other case so the caller falls back to the
 * normal blocking wait.
 *
 * Pure: no side effects on the OdysseyStore. The caller is responsible
 * for recording the `continuation_injected` audit event AFTER deciding
 * to use the result — this lets it re-check `hasQueuedFollowUp` post-
 * await and drop the synthesized followUp if user input has arrived in
 * the meantime, without polluting the audit history.
 *
 * Called from `ToolUseWaitNode.exec()` BEFORE `session.waitForFollowUp`
 * — the wait blocks indefinitely on an empty queue, so the continuation
 * cannot run after it. See `prds/prd-odyssey.md` §5.3.
 */
export async function maybeBuildOdysseyContinuation(
  ctx: OdysseyContinuationContext,
): Promise<string | null> {
  if (ctx.isSubagent) return null;
  if (ctx.hasQueuedFollowUp) return null;
  if (!platform().config.get<boolean>(ODYSSEY_FEATURE_FLAG_KEY, false)) {
    return null;
  }

  const odyssey = OdysseyStore.getForStream(ctx.streamId);
  if (!odyssey || odyssey.status !== 'active') return null;

  return buildContinuationFollowUp(odyssey);
}
