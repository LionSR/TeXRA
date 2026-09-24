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
 * The bypass kinds each run's goal turned on itself. Ending or narrowing the
 * goal revokes only these, so a grant the user made before the goal or
 * during it (answering an edit prompt with "approve for this session") stays
 * standing after the goal ends.
 */
const goalGrants = new WeakMap<
  SessionApprovals,
  Map<RunId, Set<GoalGrantKind>>
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
  const granted = byRun.get(runId) ?? new Set<GoalGrantKind>();
  const wanted = scope === false ? [] : SCOPE_KINDS[scope];
  // Revoke before granting, and keep a kind both scopes share: retargeting
  // from all-agent-work to commands must not publish a transient command
  // revocation immediately before re-enabling it.
  for (const kind of granted) {
    if (wanted.includes(kind)) continue;
    bypassOf(approvals, kind).setBypass(runId, false);
    granted.delete(kind);
  }
  for (const kind of wanted) {
    const bypass = bypassOf(approvals, kind);
    if (granted.has(kind) || bypass.isBypassed(runId)) continue;
    bypass.setBypass(runId, true);
    granted.add(kind);
  }
  if (granted.size === 0) byRun.delete(runId);
  else byRun.set(runId, granted);
}
