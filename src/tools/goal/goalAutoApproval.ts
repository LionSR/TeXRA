import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas/identifiers';

/**
 * Engage or clear the per-stream bash + tool-edit approval bypass for an
 * autonomous goal.
 *
 * "Approve & Run Autonomously" is the user's explicit consent to unattended
 * execution; without the bypass, the first bash/edit approval prompt silently
 * parks the loop, which reads as the goal "stopping early". Engaged when a
 * goal starts or is retargeted, cleared whenever it pauses or ends so manual
 * follow-up turns prompt normally again.
 *
 * Subagents inherit the parent stream's bypass through the existing
 * delegation wiring (`inheritBashBypassOnChildStream`), so no child-stream
 * handling is needed here.
 *
 * The approval modules are imported lazily: this file sits in the host-neutral
 * agent-loop import graph (via ToolUseWaitNode), and pulling the approval
 * modules at module scope drags their filesystem/logger imports into every
 * consumer — breaking partial logger mocks in CLI tests.
 */
export async function setGoalSessionAutoApprovals(
  streamId: StreamTabId,
  enabled: boolean,
  runtimeHost: AgentRuntimeHost,
): Promise<void> {
  const [
    { setBashApprovalSessionBypass },
    { setToolEditApprovalSessionBypass },
  ] = await Promise.all([
    import('@tools/approval/bashApproval'),
    import('@tools/approval/toolEditApproval'),
  ]);
  setBashApprovalSessionBypass(streamId, enabled, runtimeHost);
  setToolEditApprovalSessionBypass(streamId, enabled, runtimeHost);
}
