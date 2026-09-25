import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionApprovals } from '@agent/runtime/runApprovalQueue';
import type { RunId } from '@shared/schemas';

export type GoalAutoApprovalScope = 'commands' | 'allAgentWork';

type GoalGrantKind = 'bash' | 'toolEdit' | 'proposal';

const SCOPE_KINDS: Record<GoalAutoApprovalScope, readonly GoalGrantKind[]> = {
  commands: ['bash'],
  allAgentWork: ['proposal', 'toolEdit', 'bash'],
};

const bypassOf = (approvals: SessionApprovals, kind: GoalGrantKind) =>
  kind === 'proposal' ? approvals.proposal : approvals[kind].bypass;

/**
 * The bypass kinds each run's goal turned on itself, each with the run's own
 * value from before the grant (`undefined`: it deferred to its ancestry).
 * Ending or narrowing the goal restores only these, so a grant the user made
 * on the run before the goal stays standing after the goal ends, and a
 * delegated child that inherited its parent's bypass defers to the parent
 * again rather than being pinned off.
 */
const goalGrants = new WeakMap<
  SessionApprovals,
  Map<RunId, Map<GoalGrantKind, boolean | undefined>>
>();

/**
 * Apply one goal's selected approval scope, or revoke every grant the goal
 * made, on the session that owns the run. Commands-only remains the default:
 * an approved plan is not consent to edit files or launch delegated work
 * unless the user explicitly enables the broader scope. Descendants inherit
 * each bypass through session ancestry.
 */
export function setGoalSessionAutoApproval(
  session: SessionHandle,
  runId: RunId,
  scope: GoalAutoApprovalScope | false,
): void {
  const approvals = session.approvals;
  let byRun = goalGrants.get(approvals);
  if (!byRun) {
    byRun = new Map();
    goalGrants.set(approvals, byRun);
  }
  const granted =
    byRun.get(runId) ?? new Map<GoalGrantKind, boolean | undefined>();
  const wanted = scope === false ? [] : SCOPE_KINDS[scope];
  // Revoke before granting, and keep a kind both scopes share: retargeting
  // from all-agent-work to commands must not publish a transient command
  // revocation immediately before re-enabling it.
  for (const [kind, previous] of granted) {
    if (wanted.includes(kind)) continue;
    bypassOf(approvals, kind).setBypass(runId, previous);
    granted.delete(kind);
  }
  for (const kind of wanted) {
    const bypass = bypassOf(approvals, kind);
    // Only the run's own value counts as already granted: a value inherited
    // from a parent ends with the parent's grant, so the goal writes its own.
    const own = bypass.ownBypass(runId);
    if (granted.has(kind) || own === true) continue;
    bypass.setBypass(runId, true);
    granted.set(kind, own);
  }
  if (granted.size === 0) byRun.delete(runId);
  else byRun.set(runId, granted);
}
