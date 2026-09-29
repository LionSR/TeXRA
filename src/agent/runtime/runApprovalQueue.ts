/**
 * The session's requests: the run-scoped approval controllers and the
 * {@link SessionRequests} value they are reached through.
 *
 * The controllers encapsulate the shared concerns of bash and tool-edit
 * approvals:
 *   - serialized request queues (one prompt at a time per run)
 *   - per-run bypass state, published as the run's `approval.policy` row
 *
 * Controller instances live on {@link SessionApprovals}, one per session
 * (#8144) — there is no process-global controller, so two sessions queue,
 * resolve, and clean up approvals independently. A session's value is
 * reached through the session itself (`SessionHandle.requests`), never from
 * context: every holder of it already holds the session it belongs to.
 */

import { Effect } from 'effect';

import {
  APPROVAL_BYPASS_KINDS,
  type ApprovalBypassKind,
} from '@shared/approvalBypassKind';
import type {
  ApprovalPolicySnapshot,
  CommitOrdinal,
  RunId,
} from '@shared/schemas';
import type { DeletionMode } from '@shared/session/database';
import type { RequestError } from '@shared/session/requestErrors';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';

/**
 * Per-run bypass state. Its one announcement channel is the run's
 * `approval.policy` row, published by the session through `onPolicyChanged`.
 *
 * Single implementation behind the tool-edit, bash, and proposal (super-YOLO)
 * bypass values, so set/clear semantics and publication stay uniform
 * across approval kinds.
 *
 * A run holds two values per kind, a human's (`setBypass`) and its
 * autonomous goal's temporary grant (`SessionApprovals.setGoalGrant`), and
 * neither overwrites the other: the latest decision on the run wins, so a
 * human write ends the goal's grant of that kind, and ending the goal's
 * grant leaves what the human decided, or the inheritance, standing.
 *
 * A run with no value of its own defers to its ancestor chain (see
 * `resolveParent`) rather than defaulting straight to `false` — this is
 * what lets a delegated subagent run, or the next round of a CLI
 * conversation, inherit a bypass its predecessor turned on, without a
 * one-shot copy that misses toggles made after the child/round was created.
 */
interface RunApprovalBypass {
  isBypassed(runId: RunId): boolean;
  /** The run's effective bypass is on because an autonomous goal's grant
   *  decides it, not a human. */
  isAutonomous(runId: RunId): boolean;
  /** The run's own human value, or `undefined` when it defers to its
   *  ancestor chain. */
  ownBypass(runId: RunId): boolean | undefined;
  /**
   * A human's bypass for a run; `undefined` drops the run's own value so it
   * defers to its ancestor chain again. It supersedes the run's goal grant
   * of this kind. Publishes the run's new `approval.policy` snapshot unless
   * `silent`, which is pre-activation setup for a run no surface shows yet.
   */
  setBypass(
    runId: RunId,
    enabled: boolean | undefined,
    options?: { silent?: boolean },
  ): void;
  clearAll(): void;
}

/**
 * Internal bypass surface: the goal grant, which only
 * `SessionApprovals.setGoalGrant` writes, and per-run value teardown, which
 * only the ancestry owner (`forgetRunAncestry`) may call — clearing a run's
 * explicit values before its children are promoted would silently revoke
 * their inherited bypasses.
 */
interface RunApprovalBypassState extends RunApprovalBypass {
  /** Whether the run's own autonomous goal grants this kind. */
  goalGranted(runId: RunId): boolean;
  setGoalGrant(runId: RunId, granted: boolean): void;
  /** Pin the human value the run inherits as its own, before its edge
   *  goes: an ancestor's goal grant ends with that ancestor's goal. */
  promoteHuman(runId: RunId): void;
  clearForRun(runId: RunId): void;
}

function createRunApprovalBypass(
  resolveParent: (runId: RunId) => RunId | undefined,
  resolveDescendants: (runId: RunId) => readonly RunId[],
  onEffectiveChange: (runId: RunId) => void,
): RunApprovalBypassState {
  const byRun = new Map<RunId, boolean>();
  // The runs this kind is granted on by their own autonomous goal.
  const goalRuns = new Set<RunId>();
  const decides = (runId: RunId) => goalRuns.has(runId) || byRun.has(runId);

  /** The nearest run in `runId`'s chain, itself first, that `has` a value. */
  function decidingRun(
    runId: RunId,
    has: (runId: RunId) => boolean,
  ): RunId | undefined {
    const seen = new Set<RunId>();
    let current: RunId | undefined = runId;
    while (current && !seen.has(current)) {
      if (has(current)) return current;
      seen.add(current);
      current = resolveParent(current);
    }
    return undefined;
  }

  function resolve(runId: RunId): boolean {
    const deciding = decidingRun(runId, decides);
    return (
      deciding !== undefined &&
      (goalRuns.has(deciding) || byRun.get(deciding) === true)
    );
  }

  /** Write, then report the run and each descendant whose value moved. */
  function change(runId: RunId, write: () => void, silent = false): void {
    const descendants = silent ? [] : resolveDescendants(runId);
    const before = descendants.map(resolve);
    write();
    if (silent) return;
    onEffectiveChange(runId);
    for (const [index, descendant] of descendants.entries()) {
      if (before[index] !== resolve(descendant)) onEffectiveChange(descendant);
    }
  }

  return {
    isBypassed: resolve,
    isAutonomous(runId) {
      const deciding = decidingRun(runId, decides);
      return deciding !== undefined && goalRuns.has(deciding);
    },
    ownBypass: (runId) => byRun.get(runId),
    goalGranted: (runId) => goalRuns.has(runId),
    setBypass(runId, enabled, options) {
      change(
        runId,
        () => {
          if (enabled === undefined) byRun.delete(runId);
          else byRun.set(runId, enabled);
          goalRuns.delete(runId);
        },
        options?.silent,
      );
    },
    setGoalGrant(runId, granted) {
      if (goalRuns.has(runId) === granted) return;
      change(runId, () => {
        if (granted) goalRuns.add(runId);
        else goalRuns.delete(runId);
      });
    },
    promoteHuman(runId) {
      if (byRun.has(runId)) return;
      const deciding = decidingRun(runId, (run) => byRun.has(run));
      byRun.set(runId, deciding !== undefined && byRun.get(deciding) === true);
    },
    clearForRun(runId) {
      byRun.delete(runId);
      goalRuns.delete(runId);
    },
    clearAll() {
      byRun.clear();
      goalRuns.clear();
    },
  };
}

/**
 * One queued approval. `bypassed` exists because the queue can hold a request
 * behind another run prompt for arbitrarily long: if the user turns the
 * run's bypass on while this one waits (typically by answering the prompt
 * ahead of it with "approve and stop asking"), prompting anyway would ignore
 * the decision they just made.
 */
interface QueuedApproval<A, E, R> {
  /** Open the request and wait for its decision. */
  readonly prompt: Effect.Effect<A, E, R>;
  /** Result used instead when the run is bypassed by dispatch time. */
  readonly bypassed: Effect.Effect<A, E, R>;
}

interface RunApprovalController {
  bypass: RunApprovalBypass;
  /**
   * Serialize one prompt at a time per run, re-checking the run's bypass
   * at dispatch rather than at enqueue.
   */
  enqueue<A, E, R>(
    runId: RunId | undefined,
    approval: QueuedApproval<A, E, R>,
  ): Effect.Effect<A, E, R>;
}

function createRunApprovalController(
  bypass: RunApprovalBypass,
): RunApprovalController {
  // One exclusive lane per run: the queue a run's prompts take in turn, in
  // the order they were enqueued. `withPerKeyLane` owns the entries, so a
  // run's lane leaves the map once its last prompt settles.
  const lanes = new Map<RunId | undefined, PerKeyLane>();

  return {
    bypass,
    enqueue<A, E, R>(
      runId: RunId | undefined,
      approval: QueuedApproval<A, E, R>,
    ): Effect.Effect<A, E, R> {
      // The suspend runs once this prompt reaches the head of the lane, so
      // the bypass is still read at dispatch rather than at enqueue.
      return Effect.suspend(() =>
        runId && bypass.isBypassed(runId) ? approval.bypassed : approval.prompt,
      ).pipe(withPerKeyLane(lanes, runId));
    },
  };
}

/**
 * Session-owned approval state: the tool-edit and bash controllers plus the
 * delegation-proposal (super-YOLO) bypass. One instance per session, built by
 * the session layer as the `approvals` of its {@link SessionRequests};
 * run-scoped code receives its session's instance as data and host code
 * passes its own session explicitly.
 */
export interface SessionApprovals {
  readonly toolEdit: RunApprovalController;
  readonly bash: RunApprovalController;
  /**
   * Per-run bypass for agent delegation proposals (super-YOLO). Proposals
   * settle through the run coordinators rather than a run approval queue,
   * so unlike bash / tool-edit there is no controller — only bypass state.
   */
  readonly proposal: RunApprovalBypass;
  /**
   * Set the complete delegated-task approval mode for one run: later
   * delegation proposals, file edits, and commands are all approved for it.
   *
   * This is the shared meaning of the extension's "Super Yolo" control. Approval state is session-owned, so the grant cannot leak to
   * another CLI, extension, or desktop session.
   */
  setDelegatedWorkBypasses(runId: RunId, enabled: boolean): void;
  /**
   * Set exactly the kinds a run's autonomous goal grants it; empty ends the
   * grant. A kind the goal no longer grants falls back to the run's human
   * value or its inheritance: nothing the goal replaced is written back, so
   * a human choice made during the goal stands.
   */
  setGoalGrant(runId: RunId, kinds: readonly ApprovalBypassKind[]): void;
  /** Every kind's effective bypass for one run: the `bypasses` half of
   *  the run's `approval.policy` snapshot. */
  bypassesFor(runId: RunId): ApprovalPolicySnapshot['bypasses'];
  /** Everything the run's snapshot says of its bypasses: the effective
   *  values ({@link bypassesFor}), the run's own human ones and the kinds
   *  its goal grants. */
  grantsFor(
    runId: RunId,
  ): Pick<ApprovalPolicySnapshot, 'bypasses' | 'own' | 'goal'>;
  /**
   * Rebuild a run's own bypass values from its last durable
   * `approval.policy` snapshot, for each kind this session holds no own
   * value of (a resume in a new process). A human's grant and an explicit
   * override come back as they were; an inherited value stays inherited, so
   * a later change on the parent still reaches the run; a goal's grant is
   * not restored, so it stays off until a human re-arms the goal. Silent: the resume
   * publishes the rebuilt snapshot itself.
   */
  restoreRun(runId: RunId, snapshot: ApprovalPolicySnapshot): void;
  /**
   * Record that `childRunId` descends from `parentRunId` for bypass
   * resolution purposes: every bypass kind defers to the parent's bypass
   * state whenever the child has no explicit value of its own. Each kind
   * still keeps its own values, so a parent with bash bypassed but edits
   * gated propagates exactly that split.
   *
   * Used for delegated subagent runs (parent = the orchestrator run,
   * so complete delegated-task approval remains effective through nested
   * orchestrators; see `configureDelegatedChildApprovals`) and, in the CLI,
   * successive conversation rounds (parent = the previous round's root
   * run — a CLI round should carry forward whichever bypasses were on) —
   * both mint a fresh `RunId` that would otherwise start every bypass
   * kind ungated.
   */
  registerRunParent(childRunId: RunId, parentRunId: RunId): void;
  /**
   * Promote a run out of its approval ancestry while preserving each human
   * value it inherited as an explicit value on the run. An ancestor's goal
   * grant is not carried: it ends with that goal.
   */
  detachRunFromParent(runId: RunId): void;
  /**
   * Drop `runId` from the ancestry graph and clear its explicit bypass
   * values for every kind. Direct children are first promoted through
   * {@link detachRunFromParent}, preserving their effective values before
   * the torn-down parent's own values are cleared.
   */
  forgetRunAncestry(runId: RunId): void;
  /**
   * Clear all bypass + proposal + ancestry state for this session.
   */
  clearAll(): void;
}

/**
 * `onPolicyChanged` fires for every run whose effective bypass state
 * moved, after the values are written: a non-silent `setBypass`, and a goal
 * grant that changes, reports the
 * run and each affected descendant, and `registerRunParent` reports
 * the child and each of its descendants whose inherited value the new edge
 * changed. The session publishes that run's `approval.policy` snapshot
 * from it — the one channel this state travels. Silent writes are
 * pre-activation setup for a run no surface shows yet and publish nothing.
 */
export function createSessionApprovals(
  onPolicyChanged: (runId: RunId) => void = () => {},
): SessionApprovals {
  // One ancestry graph: "who is this run's parent" is kind-independent.
  // The per-kind split lives in the bypass *values* — each
  // `createRunApprovalBypass` owns its own `byRun` map — so a parent
  // with bash bypassed but edits gated still propagates exactly that split.
  const parentOf = new Map<RunId, RunId>();
  // The inverse of `parentOf`, written only through `link`/`unlink`, so a
  // descendant walk visits the subtree instead of every edge in the session.
  const childrenOf = new Map<RunId, Set<RunId>>();
  const unlink = (child: RunId): void => {
    const parent = parentOf.get(child);
    if (parent === undefined) return;
    parentOf.delete(child);
    const siblings = childrenOf.get(parent);
    siblings?.delete(child);
    if (siblings?.size === 0) childrenOf.delete(parent);
  };
  const link = (child: RunId, parent: RunId): void => {
    unlink(child);
    parentOf.set(child, parent);
    const siblings = childrenOf.get(parent);
    if (siblings) siblings.add(child);
    else childrenOf.set(parent, new Set([child]));
  };
  const resolveParent = (runId: RunId): RunId | undefined =>
    parentOf.get(runId);
  const resolveDescendants = (runId: RunId): readonly RunId[] => {
    // Breadth-first from `runId`; every id discovered is appended after it,
    // so the walk's own queue is the result minus the root.
    const pending = [runId];
    const seen = new Set(pending);
    for (let index = 0; index < pending.length; index += 1) {
      for (const child of childrenOf.get(pending[index]) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        pending.push(child);
      }
    }
    return pending.slice(1);
  };

  const toolEditBypass = createRunApprovalBypass(
    resolveParent,
    resolveDescendants,
    onPolicyChanged,
  );
  const bashBypass = createRunApprovalBypass(
    resolveParent,
    resolveDescendants,
    onPolicyChanged,
  );
  const toolEdit = createRunApprovalController(toolEditBypass);
  const bash = createRunApprovalController(bashBypass);
  const proposal = createRunApprovalBypass(
    resolveParent,
    resolveDescendants,
    onPolicyChanged,
  );
  const byKind: Record<ApprovalBypassKind, RunApprovalBypassState> = {
    bash: bashBypass,
    toolEdit: toolEditBypass,
    superYolo: proposal,
  };
  const bypasses: readonly RunApprovalBypassState[] = Object.values(byKind);

  function detachRunFromParent(runId: RunId): void {
    if (!parentOf.has(runId)) return;
    // Pin every inherited value BEFORE dropping the edge: resolving after
    // the delete would report `false` for a kind the run only inherited,
    // silently revoking that bypass instead of pinning it.
    for (const bypass of bypasses) bypass.promoteHuman(runId);
    unlink(runId);
  }

  const bypassesFor = (runId: RunId): ApprovalPolicySnapshot['bypasses'] => ({
    bash: bashBypass.isBypassed(runId),
    toolEdit: toolEditBypass.isBypassed(runId),
    superYolo: proposal.isBypassed(runId),
  });
  const grantsFor: SessionApprovals['grantsFor'] = (runId) => {
    const own: ApprovalPolicySnapshot['own'] = {};
    for (const kind of APPROVAL_BYPASS_KINDS) {
      const value = byKind[kind].ownBypass(runId);
      if (value !== undefined) own[kind] = value ? 'on' : 'off';
    }
    const goal = APPROVAL_BYPASS_KINDS.filter((kind) =>
      byKind[kind].goalGranted(runId),
    );
    return { bypasses: bypassesFor(runId), own, goal };
  };
  // What a new ancestry edge can move: the run's effective values.
  const policyKey = (runId: RunId) => JSON.stringify(bypassesFor(runId));

  return {
    toolEdit,
    bash,
    proposal,
    bypassesFor,
    grantsFor,
    restoreRun(runId, snapshot) {
      for (const kind of APPROVAL_BYPASS_KINDS) {
        const durable = snapshot.own[kind];
        const bypass = byKind[kind];
        if (durable === undefined) continue;
        if (bypass.ownBypass(runId) !== undefined) continue;
        bypass.setBypass(runId, durable === 'on', { silent: true });
      }
    },
    setDelegatedWorkBypasses(runId, enabled) {
      proposal.setBypass(runId, enabled);
      // Unconditional: write the run's own explicit tool-edit entry even
      // when `isBypassed` already reports true, because that can be an
      // ancestry-resolved inheritance from the parent — super-YOLO granted
      // here must survive the parent later re-gating its own edits.
      toolEdit.bypass.setBypass(runId, enabled);
      bash.bypass.setBypass(runId, enabled);
    },
    setGoalGrant(runId, kinds) {
      for (const kind of APPROVAL_BYPASS_KINDS) {
        byKind[kind].setGoalGrant(runId, kinds.includes(kind));
      }
    },
    registerRunParent(childRunId, parentRunId) {
      // The child's `run.start` already carried its snapshot without this
      // edge, so every run the inheritance moves publishes a fresh one.
      const affected = [childRunId, ...resolveDescendants(childRunId)];
      const before = new Map(
        affected.map((runId) => [runId, policyKey(runId)]),
      );
      link(childRunId, parentRunId);
      for (const runId of affected) {
        if (before.get(runId) !== policyKey(runId)) onPolicyChanged(runId);
      }
    },
    detachRunFromParent,
    forgetRunAncestry(runId) {
      const directChildren = [...(childrenOf.get(runId) ?? [])];
      for (const child of directChildren) detachRunFromParent(child);
      unlink(runId);
      // Only after the children were promoted: clearing the parent's
      // explicit values first would resolve an inherited bypass to `false`
      // and silently revoke it.
      for (const bypass of bypasses) bypass.clearForRun(runId);
    },
    clearAll() {
      for (const bypass of bypasses) bypass.clearAll();
      parentOf.clear();
      childrenOf.clear();
    },
  };
}

/**
 * Everything a surface asks of one session: its approval state and the one
 * handler every request goes through (PRD one-fold-three-renderers, 7.6 and
 * 8.2). Built by the session layer over that session's log and doors
 * (`SessionRequests.ts`); one value per session, so two sessions admit,
 * serialize and answer requests independently.
 */
export interface SessionRequests {
  /** This session's approval queues, bypass state and run ancestry. */
  readonly approvals: SessionApprovals;
  /** Answer one request a surface issued: exactly once, an {@link Outcome}
   *  the host renders or a request error. */
  readonly request: (
    req: RuntimeRequest,
  ) => Effect.Effect<Outcome, RequestError>;
  /** Internal deletion policies share the same admission and transaction as
   *  a user's `run.delete`. */
  readonly removeRun: (
    runId: RunId,
    mode: DeletionMode,
    expectedStartCommit: CommitOrdinal,
  ) => Effect.Effect<Outcome, RequestError>;
}
