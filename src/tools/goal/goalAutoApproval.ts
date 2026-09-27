import { Context, Effect, Layer } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionApprovals } from '@agent/runtime/runApprovalQueue';
import type { RunId } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

export type GoalAutoApprovalScope = 'commands' | 'allAgentWork';

type GoalGrantKind = 'bash' | 'toolEdit' | 'proposal';

const SCOPE_KINDS: Record<GoalAutoApprovalScope, readonly GoalGrantKind[]> = {
  commands: ['bash'],
  allAgentWork: ['proposal', 'toolEdit', 'bash'],
};

const bypassOf = (approvals: SessionApprovals, kind: GoalGrantKind) =>
  kind === 'proposal' ? approvals.proposal : approvals[kind].bypass;

/**
 * The goal plugin's session service (`PLUGIN_SESSION_LAYERS`): the bypass
 * kinds each run's goal turned on itself in this session, each with the
 * run's own value from before the grant (`undefined`: it deferred to its
 * ancestry). Ending or narrowing the goal restores only these, so a grant
 * the user made on the run before the goal stays standing after the goal
 * ends, and a delegated child that inherited its parent's bypass defers to
 * the parent again rather than being pinned off.
 */
export class GoalGrants extends Context.Service<
  GoalGrants,
  Map<RunId, Grants>
>()('@texra/tools/GoalGrants') {}

/** One run's grants: each kind with the run's own value before it. */
interface Grants {
  readonly approvals: SessionApprovals;
  readonly kinds: Map<GoalGrantKind, boolean | undefined>;
}

/** Restore each kind a run's goal granted to the value before it. */
const restore = (runId: RunId, grants: Grants, keep: readonly string[]) => {
  for (const [kind, previous] of grants.kinds) {
    if (keep.includes(kind)) continue;
    bypassOf(grants.approvals, kind).setBypass(runId, previous);
    grants.kinds.delete(kind);
  }
};

/**
 * One session's goal grants, empty when the session opens. Releasing the
 * layer (the goal plugin switched off and unpinned, or the session closing)
 * revokes every grant it holds: no goal grant outlives the plugin.
 */
export const goalGrantsLayer = Layer.effect(
  GoalGrants,
  Effect.acquireRelease(
    Effect.sync(() => new Map<RunId, Grants>()),
    (byRun) =>
      Effect.forEach(
        byRun,
        ([runId, grants]) =>
          Effect.try({
            try: () => restore(runId, grants, []),
            catch: ensureError,
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `A goal grant on run ${runId} was not revoked: ${error.message}`,
              ),
            ),
          ),
        { discard: true },
      ),
  ),
);

/**
 * Apply one goal's selected approval scope, or revoke every grant the goal
 * made, on the session that owns the run. Commands-only remains the default:
 * an approved plan is not consent to edit files or launch delegated work
 * unless the user explicitly enables the broader scope. Descendants inherit
 * each bypass through session ancestry.
 */
export const setGoalSessionAutoApproval = (
  session: SessionHandle,
  runId: RunId,
  scope: GoalAutoApprovalScope | false,
): Effect.Effect<void, never, GoalGrants> =>
  Effect.map(GoalGrants, (byRun) => {
    const approvals = session.approvals;
    const grants = byRun.get(runId) ?? { approvals, kinds: new Map() };
    const granted = grants.kinds;
    const wanted = scope === false ? [] : SCOPE_KINDS[scope];
    // Revoke before granting, and keep a kind both scopes share: retargeting
    // from all-agent-work to commands must not publish a transient command
    // revocation immediately before re-enabling it.
    restore(runId, grants, wanted);
    for (const kind of wanted) {
      const bypass = bypassOf(approvals, kind);
      // Only the run's own value counts as already granted: a value inherited
      // from a parent ends with the parent's grant, so the goal writes its own.
      const own = bypass.ownBypass(runId);
      if (granted.has(kind) || own === true) continue;
      // Autonomous: a resume in a new process leaves this grant off until a
      // human re-arms the goal.
      bypass.setBypass(runId, true, { autonomous: true });
      granted.set(kind, own);
    }
    if (granted.size === 0) byRun.delete(runId);
    else byRun.set(runId, grants);
  });
