/**
 * Generic run-scoped approval controller, owned per session.
 *
 * Encapsulates the shared concerns of bash and tool-edit approvals:
 *   - serialized request queues (one prompt at a time per run)
 *   - per-run bypass state announced over a bound progress event
 *
 * Controller instances live on {@link SessionApprovals}, one per
 * `SessionHandle` (#8144) — there is no process-global controller, so two
 * sessions queue, resolve, and clean up approvals independently.
 */

import { Effect, Semaphore } from 'effect';

import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import type { ApprovalPolicySnapshot, RunId } from '@shared/schemas';

import type { SessionHostInteractions } from './HostInteractions';

/**
 * Per-run bypass state bound to the host interaction that announces it.
 *
 * Single implementation behind the tool-edit, bash, and proposal (super-YOLO)
 * bypass values, so set/clear semantics and UI notification stay uniform
 * across approval kinds.
 *
 * A run with no explicit bypass value of its own defers to its ancestor
 * chain (see `resolveParent`) rather than defaulting straight to `false` —
 * this is what lets a delegated subagent run, or the next round of a CLI
 * conversation, inherit a bypass its predecessor turned on, without a
 * one-shot copy that misses toggles made after the child/round was created.
 */
export interface RunApprovalBypass {
  isBypassed(runId: RunId): boolean;
  /**
   * Set bypass for a run. Notifies the active host interaction (unless
   * `silent`); omit the interaction host for pre-activation setup where no UI
   * exists yet.
   */
  setBypass(
    runId: RunId,
    enabled: boolean,
    options?: { silent?: boolean },
  ): void;
  clearAll(): void;
}

/**
 * Internal bypass surface: adds per-run value teardown, which only the
 * ancestry owner (`forgetRunAncestry`) may call — clearing a run's
 * explicit values before its children are promoted would silently revoke
 * their inherited bypasses.
 */
interface RunApprovalBypassState extends RunApprovalBypass {
  clearForRun(runId: RunId): void;
}

function createRunApprovalBypass(
  kind: ApprovalBypassKind,
  interactions: Pick<SessionHostInteractions, 'setApprovalBypassState'>,
  resolveParent: (runId: RunId) => RunId | undefined,
  resolveDescendants: (runId: RunId) => readonly RunId[],
  onEffectiveChange: (runId: RunId) => void,
): RunApprovalBypassState {
  const byRun = new Map<RunId, boolean>();

  function resolve(runId: RunId): boolean {
    const seen = new Set<RunId>();
    let current: RunId | undefined = runId;
    while (current && !seen.has(current)) {
      const explicit = byRun.get(current);
      if (explicit !== undefined) return explicit;
      seen.add(current);
      current = resolveParent(current);
    }
    return false;
  }

  const setBypass: RunApprovalBypass['setBypass'] = (
    runId,
    enabled,
    options,
  ) => {
    if (options?.silent) {
      byRun.set(runId, enabled);
      return;
    }

    const descendants = resolveDescendants(runId);
    const previousDescendantStates = new Map(
      descendants.map((descendant) => [descendant, resolve(descendant)]),
    );
    byRun.set(runId, enabled);
    interactions.setApprovalBypassState({
      runId,
      kind,
      bypassActive: enabled,
    });
    onEffectiveChange(runId);
    for (const descendant of descendants) {
      const bypassActive = resolve(descendant);
      if (previousDescendantStates.get(descendant) !== bypassActive) {
        interactions.setApprovalBypassState({
          runId: descendant,
          kind,
          bypassActive,
        });
        onEffectiveChange(descendant);
      }
    }
  };

  return {
    isBypassed: resolve,
    setBypass,
    clearForRun(runId) {
      byRun.delete(runId);
    },
    clearAll() {
      byRun.clear();
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
  // One permit per run: the lane a run's prompts take in turn. A lane is
  // held for the session's life, like the bypass values beside it.
  const lanes = new Map<RunId | undefined, Semaphore.Semaphore>();
  const laneOf = (runId: RunId | undefined): Semaphore.Semaphore => {
    let lane = lanes.get(runId);
    if (lane === undefined) {
      lane = Semaphore.makeUnsafe(1);
      lanes.set(runId, lane);
    }
    return lane;
  };

  return {
    bypass,
    enqueue<A, E, R>(
      runId: RunId | undefined,
      approval: QueuedApproval<A, E, R>,
    ): Effect.Effect<A, E, R> {
      return laneOf(runId).withPermit(
        Effect.suspend(() =>
          runId && bypass.isBypassed(runId)
            ? approval.bypassed
            : approval.prompt,
        ),
      );
    },
  };
}

/**
 * Session-owned approval state: the tool-edit and bash controllers plus the
 * delegation-proposal (super-YOLO) bypass. One instance per `SessionHandle`
 * (`session.approvals`); run-scoped code resolves it through
 * `currentSession()`, host code passes its own session explicitly.
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
  /** Every kind's effective bypass for one run: the `bypasses` half of
   *  the run's `approval.policy` snapshot. */
  bypassesFor(runId: RunId): ApprovalPolicySnapshot['bypasses'];
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
   * Promote a run out of its approval ancestry while preserving each
   * effective bypass value as an explicit value on the run.
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
 * moved, after the values are written: a non-silent `setBypass` reports the
 * run and each affected descendant, and `registerRunParent` reports
 * the child and each of its descendants whose inherited value the new edge
 * changed. The session publishes that run's `approval.policy` snapshot
 * from it. Silent writes are pre-activation setup for a run no host shows
 * yet and publish nothing, exactly as they notify no host.
 */
export function createSessionApprovals(
  interactions: Pick<SessionHostInteractions, 'setApprovalBypassState'>,
  onPolicyChanged: (runId: RunId) => void = () => {},
): SessionApprovals {
  // One ancestry graph: "who is this run's parent" is kind-independent.
  // The per-kind split lives in the bypass *values* — each
  // `createRunApprovalBypass` owns its own `byRun` map — so a parent
  // with bash bypassed but edits gated still propagates exactly that split.
  const parentOf = new Map<RunId, RunId>();
  const resolveParent = (runId: RunId): RunId | undefined =>
    parentOf.get(runId);
  const resolveDescendants = (runId: RunId): readonly RunId[] => {
    const descendants: RunId[] = [];
    const pending = [runId];
    const seen = new Set(pending);
    for (let index = 0; index < pending.length; index += 1) {
      const parent = pending[index];
      for (const [child, directParent] of parentOf) {
        if (directParent !== parent || seen.has(child)) continue;
        seen.add(child);
        descendants.push(child);
        pending.push(child);
      }
    }
    return descendants;
  };

  const toolEditBypass = createRunApprovalBypass(
    'toolEdit',
    interactions,
    resolveParent,
    resolveDescendants,
    onPolicyChanged,
  );
  const bashBypass = createRunApprovalBypass(
    'bash',
    interactions,
    resolveParent,
    resolveDescendants,
    onPolicyChanged,
  );
  const toolEdit = createRunApprovalController(toolEditBypass);
  const bash = createRunApprovalController(bashBypass);
  const proposal = createRunApprovalBypass(
    'superYolo',
    interactions,
    resolveParent,
    resolveDescendants,
    onPolicyChanged,
  );
  const bypasses: readonly RunApprovalBypassState[] = [
    toolEditBypass,
    bashBypass,
    proposal,
  ];

  function detachRunFromParent(runId: RunId): void {
    if (!parentOf.has(runId)) return;
    // Read every effective value BEFORE dropping the edge: resolving after
    // the delete would report `false` for a kind the run only inherited,
    // silently revoking that bypass instead of pinning it.
    const promoted = bypasses.map((bypass) => ({
      bypass,
      effectiveValue: bypass.isBypassed(runId),
    }));
    parentOf.delete(runId);
    for (const { bypass, effectiveValue } of promoted) {
      bypass.setBypass(runId, effectiveValue, { silent: true });
    }
  }

  const bypassesFor = (runId: RunId): ApprovalPolicySnapshot['bypasses'] => ({
    bash: bashBypass.isBypassed(runId),
    toolEdit: toolEditBypass.isBypassed(runId),
    superYolo: proposal.isBypassed(runId),
  });

  return {
    toolEdit,
    bash,
    proposal,
    bypassesFor,
    setDelegatedWorkBypasses(runId, enabled) {
      proposal.setBypass(runId, enabled);
      // Unconditional: write the run's own explicit tool-edit entry even
      // when `isBypassed` already reports true, because that can be an
      // ancestry-resolved inheritance from the parent — super-YOLO granted
      // here must survive the parent later re-gating its own edits.
      toolEdit.bypass.setBypass(runId, enabled);
      bash.bypass.setBypass(runId, enabled);
    },
    registerRunParent(childRunId, parentRunId) {
      // The child's `run.start` already carried its snapshot without this
      // edge, so every run the inheritance moves publishes a fresh one.
      const affected = [childRunId, ...resolveDescendants(childRunId)];
      const before = new Map(
        affected.map((runId) => [runId, bypassesFor(runId)]),
      );
      parentOf.set(childRunId, parentRunId);
      for (const runId of affected) {
        const previous = before.get(runId);
        const current = bypassesFor(runId);
        if (
          previous?.bash !== current.bash ||
          previous?.toolEdit !== current.toolEdit ||
          previous?.superYolo !== current.superYolo
        ) {
          onPolicyChanged(runId);
        }
      }
    },
    detachRunFromParent,
    forgetRunAncestry(runId) {
      const directChildren = [...parentOf]
        .filter(([, parent]) => parent === runId)
        .map(([child]) => child);
      for (const child of directChildren) detachRunFromParent(child);
      parentOf.delete(runId);
      // Only after the children were promoted: clearing the parent's
      // explicit values first would resolve an inherited bypass to `false`
      // and silently revoke it.
      for (const bypass of bypasses) bypass.clearForRun(runId);
    },
    clearAll() {
      for (const bypass of bypasses) bypass.clearAll();
      parentOf.clear();
    },
  };
}
