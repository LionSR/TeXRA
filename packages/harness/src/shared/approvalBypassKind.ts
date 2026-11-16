/**
 * Shared bypass-kind vocabulary for per-stream approval grants.
 *
 * Serialized wire values (`bash` | `toolEdit` | `superYolo`) are pinned —
 * rename the TypeScript aliases freely, but do not change these strings.
 * `superYolo` here is the delegated-work scoped bypass, not an approval
 * policy value.
 */
import { Schema } from 'effect';

import type { ApprovalPolicy } from './approvalPolicy';
import type { RunId } from './schemas/identifiers';

export const APPROVAL_BYPASS_KINDS = ['bash', 'toolEdit', 'superYolo'] as const;

export type ApprovalBypassKind = (typeof APPROVAL_BYPASS_KINDS)[number];

/** The policies a launch can narrow a run to: anything below Auto-approve,
 *  which is never stricter than a project's policy. */
export const APPROVAL_POLICY_LIMITS = ['never', 'ask'] as const;
export type ApprovalPolicyLimit = (typeof APPROVAL_POLICY_LIMITS)[number];

/** What a launch asks of its run's approvals: Auto-approve (its run starts
 *  with every bypass on, recorded on the run, never on the project), or a
 *  policy it narrows the run to. Absent, the run follows the project's. */
export const LaunchApprovalSchema = Schema.Union([
  Schema.Literal('autoApprove'),
  Schema.Literals(APPROVAL_POLICY_LIMITS),
]);
export type LaunchApproval = typeof LaunchApprovalSchema.Type;

/** A run's own value for one kind: a human's `on` or `off`, or `parent`,
 *  derived at an activation: follow the ancestry's human values, not its
 *  goals. */
const OwnGrantSchema = Schema.Literals(['on', 'off', 'parent']);
type OwnGrant = typeof OwnGrantSchema.Type;

/**
 * A run's own approval grants, the one record of them (its latest
 * `approval.policy` row, else its `run.start`): what the run itself
 * decided, never what it inherits. A kind the run decides nothing about
 * defers to its parent's grants while the edge stands, which is read off
 * the rows (`resolveBypass`), never stored here.
 */
export const ApprovalPolicySnapshotSchema = Schema.Struct({
  /** A human's `on` or `off` per kind, or `parent`: derived when a resume
   *  ended an ancestor's goal grant, following the ancestry's human values. */
  own: Schema.Record(
    Schema.Literals(APPROVAL_BYPASS_KINDS),
    Schema.optionalKey(OwnGrantSchema),
  ),
  /** The kinds the run's own goal grants it, over its own values, until the
   *  goal ends, a human decides the kind, or a resume ends the goal. */
  goal: Schema.Array(Schema.Literals(APPROVAL_BYPASS_KINDS)),
  /** The most permissive policy the run and its descendants run under: a
   *  launch that asked for a stricter policy than the project's narrows it
   *  for this run only, never widened (`policyLimit`). */
  limit: Schema.optional(Schema.Literals(APPROVAL_POLICY_LIMITS)),
});
export type ApprovalGrants = typeof ApprovalPolicySnapshotSchema.Type;

const STRICTNESS: Readonly<Record<ApprovalPolicy, number>> = {
  never: 0,
  ask: 1,
  yolo: 2,
};

/** The stricter of two policies (`never` < `ask` < `yolo`). */
function stricterPolicy(a: ApprovalPolicy, b: ApprovalPolicy): ApprovalPolicy {
  return STRICTNESS[a] <= STRICTNESS[b] ? a : b;
}

/**
 * The policy a launch's privileged actions (commands, edits, delegated
 * work) are decided under: the project's, narrowed by the limit the launch
 * asks for, or Auto-approve, which widens its own task but never over
 * Block. Auto-approve gets there by turning the run's grants on
 * (`rootLaunch`), not by changing the run's policy, which stays the
 * project's: a question or a retry still goes to a person where one can
 * answer it.
 */
export function launchPolicy(
  project: ApprovalPolicy,
  approval: LaunchApproval | undefined,
): ApprovalPolicy {
  if (approval === undefined) return project;
  if (approval === 'autoApprove') return project === 'never' ? 'never' : 'yolo';
  return stricterPolicy(project, approval);
}

/** A run's policy: the project's (`project`), narrowed by the strictest
 *  launch limit on its ancestry; without a run, the project's. */
export function runPolicy(
  project: ApprovalPolicy,
  source: ApprovalGrantSource,
  runId: RunId | undefined,
): ApprovalPolicy {
  const limit = runId === undefined ? undefined : policyLimit(source, runId);
  return limit === undefined ? project : stricterPolicy(project, limit);
}

/** `source` holding a run it has not applied yet with the parent edge and
 *  grants its `run.start` names: what the run is born with, read before
 *  that row commits. A run `source` holds is read as it holds it. */
export function withUnborn(
  source: ApprovalGrantSource,
  runId: RunId,
  parentId: RunId | null,
  grants: ApprovalGrants | null | undefined,
): ApprovalGrantSource {
  if (source.runs.has(runId)) return source;
  return {
    runs: new Map(source.runs).set(runId, {
      parentId,
      grants: grants ?? NO_APPROVAL_GRANTS,
    }),
  };
}

/** The strictest launch limit on a run's ancestry while its edges stand,
 *  or undefined when no launch narrowed it. */
function policyLimit(
  source: ApprovalGrantSource,
  runId: RunId,
): ApprovalPolicyLimit | undefined {
  let limit: ApprovalPolicyLimit | undefined;
  for (const grants of ancestry(source, runId)) {
    const own = grants?.limit;
    // Block is the strictest limit; any other is Ask.
    if (own !== undefined && limit !== 'never') limit = own;
  }
  return limit;
}

/** The grants of a run and each ancestor while its edges stand, the run
 *  first; a cycle in the edges ends the walk. */
function* ancestry(
  source: ApprovalGrantSource,
  runId: RunId,
): Generator<ApprovalGrants | undefined> {
  const seen = new Set();
  for (
    let current: RunId | null | undefined = runId;
    current !== null && current !== undefined && !seen.has(current);
    current = source.runs.get(current)?.parentId
  ) {
    seen.add(current);
    yield source.runs.get(current)?.grants;
  }
}

/** No grants of its own: every kind defers to the run's ancestry. */
export const NO_APPROVAL_GRANTS: ApprovalGrants = { own: {}, goal: [] };

/** The rows a bypass is read from: each run's parent edge and its own
 *  grants, as the session view folds them. */
export interface ApprovalGrantSource {
  readonly runs: ReadonlyMap<
    RunId,
    { readonly parentId: RunId | null; readonly grants: ApprovalGrants }
  >;
}

/**
 * Who bypasses one kind's prompts for a run: the nearest run in its ancestry
 * (itself first) that decides the kind, by its autonomous goal's grant
 * (`goal`) or a human's value (`human` when on); `null` when nothing grants
 * it. Past a `parent` value only human values decide. The one reading of the
 * grants, for enforcement and every surface.
 */
export function resolveBypass(
  source: ApprovalGrantSource,
  runId: RunId,
  kind: ApprovalBypassKind,
): 'goal' | 'human' | null {
  let goals = true;
  for (const grants of ancestry(source, runId)) {
    if (goals && grants?.goal.includes(kind)) return 'goal';
    const own = grants?.own[kind];
    if (own === 'parent') goals = false;
    else if (own !== undefined) return own === 'on' ? 'human' : null;
  }
  return null;
}

/** Every kind's bypass for one run, as surfaces show it. */
export function runBypasses(
  source: ApprovalGrantSource,
  runId: RunId,
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
export function inheritedGrants(
  source: ApprovalGrantSource,
  runId: RunId,
): ApprovalGrants {
  const own: Partial<Record<ApprovalBypassKind, OwnGrant>> = {};
  for (const kind of APPROVAL_BYPASS_KINDS) {
    for (const grants of ancestry(source, runId)) {
      const value = grants?.own[kind];
      if (value === undefined || value === 'parent') continue;
      own[kind] = value;
      break;
    }
  }
  const limit = policyLimit(source, runId);
  return { own, goal: [], ...(limit !== undefined && { limit }) };
}

/** The grant source over runs' rows: each run's parent edge and its grants,
 *  none for a run whose rows carry none. */
export function grantSource(
  rows: ReadonlyMap<
    RunId,
    {
      readonly parent: { readonly id: RunId } | null;
      readonly grants: ApprovalGrants | null;
    }
  >,
): ApprovalGrantSource {
  const runs = new Map<
    RunId,
    { parentId: RunId | null; grants: ApprovalGrants }
  >();
  for (const [id, own] of rows)
    runs.set(id, {
      parentId: own.parent?.id ?? null,
      grants: own.grants ?? NO_APPROVAL_GRANTS,
    });
  return { runs };
}
