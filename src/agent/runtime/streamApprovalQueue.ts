/**
 * Generic stream-scoped approval controller, owned per session.
 *
 * Encapsulates the shared concerns of bash and tool-edit approvals:
 *   - serialized request queues (one prompt at a time per stream)
 *   - registry of in-flight pending approvals keyed by request id
 *   - per-stream bypass state announced over a bound progress event
 *   - rejection on stream cleanup
 *
 * Parameterized by the approval result type so each controller can carry
 * domain-specific result fields (e.g. tool-edit appliedContent / userPatch).
 *
 * Controller instances live on {@link SessionApprovals}, one per
 * `SessionHandle` (#8144) — there is no process-global controller, so two
 * sessions queue, resolve, and clean up approvals independently.
 */

import PQueue from 'p-queue';

import type { StreamTabId } from '@shared/schemas';
import type { ToolEditApprovalResult } from '@platform/interfaces';

import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { HostBashApprovalResult } from './HostInteractions';

/** Progress events that announce per-stream approval-bypass changes. */
type ApprovalBypassEvent =
  | 'updateToolEditApprovalBypassState'
  | 'updateBashApprovalBypassState'
  | 'updateSuperYoloBypassState';

/** The three independently-tracked bypass kinds `SessionApprovals` owns. */
export type BypassAncestryKind = 'toolEdit' | 'bash' | 'proposal';

const ALL_BYPASS_ANCESTRY_KINDS: readonly BypassAncestryKind[] = [
  'toolEdit',
  'bash',
  'proposal',
];

/**
 * Per-stream bypass state bound to the progress event that announces it.
 *
 * Single implementation behind the tool-edit, bash, and proposal (super-YOLO)
 * bypass toggles, so set/toggle/clear semantics and UI notification stay
 * uniform across approval kinds.
 *
 * A stream with no explicit bypass value of its own defers to its ancestor
 * chain (see `resolveParent`) rather than defaulting straight to `false` —
 * this is what lets a delegated subagent stream, or the next round of a CLI
 * conversation, inherit a bypass its predecessor turned on, without a
 * one-shot copy that misses toggles made after the child/round was created.
 */
export interface StreamApprovalBypass {
  isBypassed(streamId: StreamTabId): boolean;
  /**
   * Set bypass for a stream. Emits the bound progress event when a
   * `runtimeHost` is provided (unless `silent`); omit the host for
   * pre-activation setup where no UI exists yet.
   */
  setBypass(
    streamId: StreamTabId,
    enabled: boolean,
    runtimeHost?: AgentRuntimeHost,
    options?: { silent?: boolean },
  ): void;
  /** Toggle per-stream bypass, announce it, and return the new state. */
  toggleBypass(streamId: StreamTabId, runtimeHost: AgentRuntimeHost): boolean;
  clearForStream(streamId: StreamTabId): void;
  clearAll(): void;
}

function createStreamApprovalBypass(
  event: ApprovalBypassEvent,
  resolveParent: (streamId: StreamTabId) => StreamTabId | undefined,
  resolveDescendants: (streamId: StreamTabId) => readonly StreamTabId[],
): StreamApprovalBypass {
  const byStream = new Map<StreamTabId, boolean>();

  function resolve(streamId: StreamTabId): boolean {
    const seen = new Set<StreamTabId>();
    let current: StreamTabId | undefined = streamId;
    while (current && !seen.has(current)) {
      const explicit = byStream.get(current);
      if (explicit !== undefined) return explicit;
      seen.add(current);
      current = resolveParent(current);
    }
    return false;
  }

  const setBypass: StreamApprovalBypass['setBypass'] = (
    streamId,
    enabled,
    runtimeHost,
    options,
  ) => {
    const descendants =
      runtimeHost && !options?.silent ? resolveDescendants(streamId) : [];
    const previousDescendantStates = new Map(
      descendants.map((descendant) => [descendant, resolve(descendant)]),
    );
    byStream.set(streamId, enabled);
    if (runtimeHost && !options?.silent) {
      runtimeHost.emit(event, { streamId, bypassActive: enabled });
      for (const descendant of descendants) {
        const bypassActive = resolve(descendant);
        if (previousDescendantStates.get(descendant) !== bypassActive) {
          runtimeHost.emit(event, {
            streamId: descendant,
            bypassActive,
          });
        }
      }
    }
  };

  return {
    isBypassed: resolve,
    setBypass,
    toggleBypass(streamId, runtimeHost) {
      // Flip the *resolved* (ancestry-aware) state, not just this stream's
      // own explicit entry — otherwise a stream inheriting `true` from a
      // parent would toggle to an explicit `true` on the first press (no
      // visible change) instead of turning bypass off.
      const next = !resolve(streamId);
      setBypass(streamId, next, runtimeHost);
      return next;
    },
    clearForStream(streamId) {
      byStream.delete(streamId);
    },
    clearAll() {
      byStream.clear();
    },
  };
}

interface PendingApproval<R extends { accepted: boolean }> {
  streamId?: StreamTabId;
  isSettled: () => boolean;
  settle: (result: R) => void;
}

interface StreamApprovalController<R extends { accepted: boolean }> {
  registerPending(id: string, entry: PendingApproval<R>): void;
  unregisterPending(id: string): void;
  bypass: StreamApprovalBypass;
  enqueue<T>(
    streamId: StreamTabId | undefined,
    run: () => Promise<T>,
  ): Promise<T>;
  rejectPendingForStream(streamId: StreamTabId): void;
  /**
   * Reject pending entries with no concrete stream context (streamId is
   * undefined or empty). The controller is session-owned, so this never
   * reaches another session's streamless approvals.
   */
  rejectUnscopedPending(): void;
  rejectAllPending(): void;
}

interface StreamApprovalControllerOptions<R extends { accepted: boolean }> {
  rejectionResult: () => R;
  bypassEvent: ApprovalBypassEvent;
  resolveParent: (streamId: StreamTabId) => StreamTabId | undefined;
  resolveDescendants: (streamId: StreamTabId) => readonly StreamTabId[];
}

function createStreamApprovalController<R extends { accepted: boolean }>(
  options: StreamApprovalControllerOptions<R>,
): StreamApprovalController<R> {
  const pending = new Map<string, PendingApproval<R>>();
  const queues = new Map<StreamTabId | undefined, PQueue>();

  function rejectWhere(
    predicate: (entry: PendingApproval<R>) => boolean,
  ): void {
    for (const entry of pending.values()) {
      if (!entry.isSettled() && predicate(entry)) {
        entry.settle(options.rejectionResult());
      }
    }
  }

  return {
    registerPending(id, entry) {
      pending.set(id, entry);
    },
    unregisterPending(id) {
      pending.delete(id);
    },
    bypass: createStreamApprovalBypass(
      options.bypassEvent,
      options.resolveParent,
      options.resolveDescendants,
    ),
    enqueue<T>(
      streamId: StreamTabId | undefined,
      run: () => Promise<T>,
    ): Promise<T> {
      let queue = queues.get(streamId);
      if (!queue) {
        queue = new PQueue({ concurrency: 1 });
        queues.set(streamId, queue);
      }

      // `add` widens to `T | void` to cover abort via signal/timeout; we pass
      // neither, so the task always runs and resolves with `T`.
      const task = queue.add(run) as Promise<T>;
      return task.finally(() => {
        if (
          queue.pending === 0 &&
          queue.size === 0 &&
          queues.get(streamId) === queue
        ) {
          queues.delete(streamId);
        }
      });
    },
    rejectPendingForStream(streamId) {
      rejectWhere((entry) => entry.streamId === streamId);
    },
    rejectUnscopedPending() {
      rejectWhere((entry) => !entry.streamId);
    },
    rejectAllPending() {
      rejectWhere(() => true);
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
  readonly toolEdit: StreamApprovalController<ToolEditApprovalResult>;
  readonly bash: StreamApprovalController<HostBashApprovalResult>;
  /**
   * Per-stream bypass for agent delegation proposals (super-YOLO). Proposals
   * settle through the run coordinators rather than a stream approval queue,
   * so unlike bash / tool-edit there is no controller — only bypass state.
   */
  readonly proposal: StreamApprovalBypass;
  /**
   * Record that `childStreamId` descends from `parentStreamId` for bypass
   * resolution purposes: each bypass kind named in `kinds` will defer to the
   * parent's bypass state whenever the child has no explicit value of its
   * own. Ancestry is tracked separately per kind — linking `bash` does NOT
   * also let the child inherit `toolEdit` or `proposal` bypass — so a
   * delegation that only wants some kinds to follow the parent can't
   * accidentally grant super-YOLO auto-approval too.
   *
   * Used for delegated subagent streams (parent = the orchestrator stream,
   * `kinds: ['bash', 'toolEdit']` — each kind follows the parent's own bypass
   * live, while `proposal` stays unlinked so a child's own delegations still
   * prompt; see `configureDelegatedChildApprovals`) and, in the CLI,
   * successive conversation rounds (parent = the previous round's root
   * stream, all kinds — a CLI round should carry forward whichever bypasses
   * were on) — both mint a fresh `StreamTabId` that would otherwise start
   * every bypass kind ungated.
   */
  registerStreamParent(
    childStreamId: StreamTabId,
    parentStreamId: StreamTabId,
    kinds?: readonly BypassAncestryKind[],
  ): void;
  /**
   * Promote a stream out of its approval ancestry while preserving each
   * effective bypass value as an explicit value on the stream.
   */
  detachStreamFromParent(streamId: StreamTabId): void;
  /**
   * Drop `streamId` from the ancestry graph (all kinds). Direct children are
   * first promoted through {@link detachStreamFromParent}, preserving their
   * effective values before the torn-down parent's own values are cleared.
   */
  forgetStreamAncestry(streamId: StreamTabId): void;
  /**
   * Reject every pending approval and clear all bypass + proposal state for
   * this session. Used by session teardown and the session-wide
   * `cleanupAllApprovals` sweep.
   */
  rejectAndClearAll(): void;
}

export function createSessionApprovals(): SessionApprovals {
  // One ancestry graph per bypass kind — deliberately NOT shared — so that
  // e.g. linking `bash` ancestry for a delegated subagent can never let it
  // also inherit `toolEdit` or `proposal` bypass from the same parent.
  const parentOf: Record<BypassAncestryKind, Map<StreamTabId, StreamTabId>> = {
    toolEdit: new Map(),
    bash: new Map(),
    proposal: new Map(),
  };
  const resolveParentFor =
    (kind: BypassAncestryKind) =>
    (streamId: StreamTabId): StreamTabId | undefined =>
      parentOf[kind].get(streamId);
  const resolveDescendantsFor =
    (kind: BypassAncestryKind) =>
    (streamId: StreamTabId): readonly StreamTabId[] => {
      const graph = parentOf[kind];
      const descendants: StreamTabId[] = [];
      const pending = [streamId];
      const seen = new Set(pending);
      for (let index = 0; index < pending.length; index += 1) {
        const parent = pending[index];
        for (const [child, directParent] of graph) {
          if (directParent !== parent || seen.has(child)) continue;
          seen.add(child);
          descendants.push(child);
          pending.push(child);
        }
      }
      return descendants;
    };

  const toolEdit = createStreamApprovalController<ToolEditApprovalResult>({
    rejectionResult: () => ({ accepted: false }),
    bypassEvent: 'updateToolEditApprovalBypassState',
    resolveParent: resolveParentFor('toolEdit'),
    resolveDescendants: resolveDescendantsFor('toolEdit'),
  });
  const bash = createStreamApprovalController<HostBashApprovalResult>({
    rejectionResult: () => ({ accepted: false }),
    bypassEvent: 'updateBashApprovalBypassState',
    resolveParent: resolveParentFor('bash'),
    resolveDescendants: resolveDescendantsFor('bash'),
  });
  const proposal = createStreamApprovalBypass(
    'updateSuperYoloBypassState',
    resolveParentFor('proposal'),
    resolveDescendantsFor('proposal'),
  );
  const bypassByKind: Record<BypassAncestryKind, StreamApprovalBypass> = {
    toolEdit: toolEdit.bypass,
    bash: bash.bypass,
    proposal,
  };

  function detachKindFromParent(
    kind: BypassAncestryKind,
    streamId: StreamTabId,
  ): void {
    const graph = parentOf[kind];
    if (!graph.has(streamId)) return;
    const bypass = bypassByKind[kind];
    const effectiveValue = bypass.isBypassed(streamId);
    graph.delete(streamId);
    bypass.setBypass(streamId, effectiveValue, undefined, { silent: true });
  }

  function detachStreamFromParent(streamId: StreamTabId): void {
    for (const kind of ALL_BYPASS_ANCESTRY_KINDS) {
      detachKindFromParent(kind, streamId);
    }
  }

  return {
    toolEdit,
    bash,
    proposal,
    registerStreamParent(
      childStreamId,
      parentStreamId,
      kinds = ALL_BYPASS_ANCESTRY_KINDS,
    ) {
      for (const kind of kinds) {
        parentOf[kind].set(childStreamId, parentStreamId);
      }
    },
    detachStreamFromParent,
    forgetStreamAncestry(streamId) {
      for (const kind of ALL_BYPASS_ANCESTRY_KINDS) {
        const graph = parentOf[kind];
        const directChildren = [...graph]
          .filter(([, parent]) => parent === streamId)
          .map(([child]) => child);
        for (const child of directChildren) detachKindFromParent(kind, child);
        graph.delete(streamId);
      }
    },
    rejectAndClearAll() {
      toolEdit.rejectAllPending();
      bash.rejectAllPending();
      toolEdit.bypass.clearAll();
      bash.bypass.clearAll();
      proposal.clearAll();
      for (const kind of ALL_BYPASS_ANCESTRY_KINDS) parentOf[kind].clear();
    },
  };
}
