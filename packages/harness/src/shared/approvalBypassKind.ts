/**
 * Shared bypass-kind vocabulary for per-stream approval grants.
 *
 * Serialized wire values (`bash` | `toolEdit` | `superYolo`) are pinned —
 * rename the TypeScript aliases freely, but do not change these strings.
 * `superYolo` here is the delegated-work scoped bypass, not a TeXRA policy
 * value.
 */
export const APPROVAL_BYPASS_KINDS = ['bash', 'toolEdit', 'superYolo'] as const;

export type ApprovalBypassKind = (typeof APPROVAL_BYPASS_KINDS)[number];

/** A run's own approval grants, as its latest `approval.policy` row (or its
 *  `run.start`) records them. */
export interface ApprovalGrants {
  readonly own: Partial<Record<ApprovalBypassKind, 'on' | 'off'>>;
  readonly goal: readonly ApprovalBypassKind[];
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
 * it. The one reading of the grants, for enforcement and every surface.
 */
export function resolveBypass<Id>(
  source: ApprovalGrantSource<Id>,
  runId: Id,
  kind: ApprovalBypassKind,
): 'goal' | 'human' | null {
  const seen = new Set<Id>();
  for (
    let current: Id | null | undefined = runId;
    current !== null && current !== undefined && !seen.has(current);
    current = source.runs.get(current)?.parentId
  ) {
    seen.add(current);
    const grants = source.policy.get(current);
    if (grants?.goal.includes(kind)) return 'goal';
    const own = grants?.own[kind];
    if (own !== undefined) return own === 'on' ? 'human' : null;
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
  const own: Partial<Record<ApprovalBypassKind, 'on' | 'off'>> = {};
  for (const kind of APPROVAL_BYPASS_KINDS) {
    const seen = new Set<Id>();
    for (
      let current: Id | null | undefined = runId;
      current !== null && current !== undefined && !seen.has(current);
      current = source.runs.get(current)?.parentId
    ) {
      seen.add(current);
      const value = source.policy.get(current)?.own[kind];
      if (value === undefined) continue;
      own[kind] = value;
      break;
    }
  }
  return { own, goal: [] };
}
