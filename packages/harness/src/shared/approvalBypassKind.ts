/**
 * Shared bypass-kind vocabulary for per-stream approval grants.
 *
 * Serialized wire values (`bash` | `toolEdit` | `superYolo`) are pinned —
 * rename the TypeScript aliases freely, but do not change these strings.
 * `superYolo` here is the delegated-work scoped bypass, not a TeXRA policy
 * value.
 */
import { z } from 'zod';

import type { TexraApprovalPolicy } from './approvalPolicy';

export const APPROVAL_BYPASS_KINDS = ['bash', 'toolEdit', 'superYolo'] as const;

export type ApprovalBypassKind = (typeof APPROVAL_BYPASS_KINDS)[number];

/** A run's own value for one kind: a human's `on` or `off`, or `parent`,
 *  derived at an activation: follow the ancestry's human values, not its
 *  goals. */
type OwnGrant = 'on' | 'off' | 'parent';

/** The policies a launch can narrow a run to: anything below Auto-approve,
 *  which is never stricter than a project's policy. */
const APPROVAL_POLICY_LIMITS = ['never', 'ask'] as const;
export type ApprovalPolicyLimit = (typeof APPROVAL_POLICY_LIMITS)[number];

/**
 * A run's own approval grants, the one record of them (its latest
 * `approval.policy` row, else its `run.start`): what the run itself
 * decided, never what it inherits. A kind the run decides nothing about
 * defers to its parent's grants while the edge stands, which is read off
 * the rows (`resolveBypass`), never stored here.
 */
export const ApprovalPolicySnapshotSchema = z.object({
  /** A human's `on` or `off` per kind, or `parent`: derived when a resume
   *  ended an ancestor's goal grant, following the ancestry's human values. */
  own: z.partialRecord(
    z.enum(APPROVAL_BYPASS_KINDS),
    z.enum(['on', 'off', 'parent']),
  ),
  /** The kinds the run's own goal grants it, over its own values, until the
   *  goal ends, a human decides the kind, or a resume ends the goal. */
  goal: z.array(z.enum(APPROVAL_BYPASS_KINDS)).readonly(),
  /** The most permissive policy the run and its descendants run under: a
   *  launch that asked for a stricter policy than the project's narrows it
   *  for this run only, never widened (`policyLimit`). */
  limit: z.enum(APPROVAL_POLICY_LIMITS).optional(),
});
export type ApprovalGrants = z.infer<typeof ApprovalPolicySnapshotSchema>;

const STRICTNESS: Readonly<Record<TexraApprovalPolicy, number>> = {
  never: 0,
  ask: 1,
  yolo: 2,
};

/** The stricter of two policies (`never` < `ask` < `yolo`). */
export function stricterPolicy(
  a: TexraApprovalPolicy,
  b: TexraApprovalPolicy,
): TexraApprovalPolicy {
  return STRICTNESS[a] <= STRICTNESS[b] ? a : b;
}

/** The strictest launch limit on a run's ancestry while its edges stand,
 *  or undefined when no launch narrowed it. */
export function policyLimit<Id>(
  source: ApprovalGrantSource<Id>,
  runId: Id,
): ApprovalPolicyLimit | undefined {
  const seen = new Set<Id>();
  let limit: ApprovalPolicyLimit | undefined;
  for (
    let current: Id | null | undefined = runId;
    current !== null && current !== undefined && !seen.has(current);
    current = source.runs.get(current)?.parentId
  ) {
    seen.add(current);
    const own = source.policy.get(current)?.limit;
    // Block is the strictest limit; any other is Ask.
    if (own !== undefined && limit !== 'never') limit = own;
  }
  return limit;
}

/** No grants of its own: every kind defers to the run's ancestry. */
export const NO_APPROVAL_GRANTS: ApprovalGrants = { own: {}, goal: [] };

/** The rows a bypass is read from: each run's parent edge and grants, as
 *  the session view folds them. */
export interface ApprovalGrantSource<Id> {
  readonly runs: ReadonlyMap<Id, { readonly parentId: Id | null }>;
  readonly policy: ReadonlyMap<Id, ApprovalGrants>;
}

/**
 * Who bypasses one kind's prompts for a run: the nearest run in its ancestry
 * (itself first) that decides the kind, by its autonomous goal's grant
 * (`goal`) or a human's value (`human` when on); `null` when nothing grants
 * it. Past a `parent` value only human values decide. The one reading of the
 * grants, for enforcement and every surface.
 */
export function resolveBypass<Id>(
  source: ApprovalGrantSource<Id>,
  runId: Id,
  kind: ApprovalBypassKind,
): 'goal' | 'human' | null {
  const seen = new Set<Id>();
  let goals = true;
  for (
    let current: Id | null | undefined = runId;
    current !== null && current !== undefined && !seen.has(current);
    current = source.runs.get(current)?.parentId
  ) {
    seen.add(current);
    const grants = source.policy.get(current);
    if (goals && grants?.goal.includes(kind)) return 'goal';
    const own = grants?.own[kind];
    if (own === 'parent') goals = false;
    else if (own !== undefined) return own === 'on' ? 'human' : null;
  }
  return null;
}

/** Every kind's bypass for one run, as surfaces show it. */
export function runBypasses<Id>(
  source: ApprovalGrantSource<Id>,
  runId: Id,
): Readonly<Record<ApprovalBypassKind, boolean>> {
  return {
    bash: resolveBypass(source, runId, 'bash') !== null,
    toolEdit: resolveBypass(source, runId, 'toolEdit') !== null,
    superYolo: resolveBypass(source, runId, 'superYolo') !== null,
  };
}

/** The human values a run's ancestry gives it, as grants of its own: what a
 *  run keeps when its edge goes, or a conversation's next round starts
 *  with. A goal's grant is not carried: it ends with its goal. */
export function inheritedGrants<Id>(
  source: ApprovalGrantSource<Id>,
  runId: Id,
): ApprovalGrants {
  const own: Partial<Record<ApprovalBypassKind, OwnGrant>> = {};
  for (const kind of APPROVAL_BYPASS_KINDS) {
    const seen = new Set<Id>();
    for (
      let current: Id | null | undefined = runId;
      current !== null && current !== undefined && !seen.has(current);
      current = source.runs.get(current)?.parentId
    ) {
      seen.add(current);
      const value = source.policy.get(current)?.own[kind];
      if (value === undefined || value === 'parent') continue;
      own[kind] = value;
      break;
    }
  }
  const limit = policyLimit(source, runId);
  return { own, goal: [], ...(limit !== undefined && { limit }) };
}
