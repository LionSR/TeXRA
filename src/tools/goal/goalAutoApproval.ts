import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';

/**
 * Engage or clear the per-stream bash approval bypass for an autonomous goal.
 *
 * "Run as Goal" is the user's explicit consent to unattended
 * command execution; without the bypass, the first verification/build command
 * silently parks the loop, which reads as the goal "stopping early". File edits
 * keep their normal diff approval prompt because an approved plan is not an
 * edit approval. Engaged when a goal starts or is retargeted, cleared whenever
 * it pauses or ends so manual follow-up turns prompt normally again.
 *
 * Subagents inherit the parent stream's bypass through the existing
 * delegation wiring (`configureDelegatedChildApprovals`), so no
 * child-stream handling is needed here — per-kind ancestry means a goal
 * parent with bash bypassed but edits gated propagates exactly that split.
 *
 * The approval modules are imported lazily: this file sits in the host-neutral
 * agent-loop import graph (via ToolUseWaitNode), and pulling the approval
 * modules at module scope drags their filesystem/logger imports into every
 * consumer — breaking partial logger mocks in CLI tests.
 */
export async function setGoalSessionBashAutoApproval(
  streamId: StreamTabId,
  enabled: boolean,
  options?: { session?: SessionHandle },
): Promise<void> {
  const { setBashApprovalSessionBypass } =
    await import('@tools/approval/bashApproval');
  setBashApprovalSessionBypass(streamId, enabled, options);
}
