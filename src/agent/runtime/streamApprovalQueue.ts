/**
 * Generic stream-scoped approval controller, owned per session.
 *
 * Encapsulates the shared concerns of bash and tool-edit approvals:
 *   - serialized request queues (one prompt at a time per stream)
 *   - per-stream bypass state announced over a bound progress event
 *
 * Controller instances live on {@link SessionApprovals}, one per
 * `SessionHandle` (#8144) — there is no process-global controller, so two
 * sessions queue, resolve, and clean up approvals independently.
 */

import PQueue from 'p-queue';

import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import type { StreamTabId } from '@shared/schemas';

import { SessionHostInteractions } from './HostInteractions';

/** The three independently-tracked bypass values `SessionApprovals` owns. */
type BypassAncestryKind = 'toolEdit' | 'bash' | 'proposal';

const ALL_BYPASS_ANCESTRY_KINDS: readonly BypassAncestryKind[] = [
  'toolEdit',
  'bash',
  'proposal',
];

/**
 * Per-stream bypass state bound to the host interaction that announces it.
 *
 * Single implementation behind the tool-edit, bash, and proposal (super-YOLO)
 * bypass values, so set/clear semantics and UI notification stay uniform
 * across approval kinds.
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
   * Set bypass for a stream. Notifies the active host interaction (unless
   * `silent`); omit the interaction host for pre-activation setup where no UI
   * exists yet.
   */
  setBypass(
    streamId: StreamTabId,
    enabled: boolean,
    options?: { silent?: boolean },
  ): void;
  clearForStream(streamId: StreamTabId): void;
  clearAll(): void;
}

function createStreamApprovalBypass(
  kind: ApprovalBypassKind,
  interactions: Pick<SessionHostInteractions, 'setApprovalBypassState'>,
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
    options,
  ) => {
    if (options?.silent) {
      byStream.set(streamId, enabled);
      return;
    }

    const descendants = resolveDescendants(streamId);
    const previousDescendantStates = new Map(
      descendants.map((descendant) => [descendant, resolve(descendant)]),
    );
    byStream.set(streamId, enabled);
    interactions.setApprovalBypassState({
      streamId,
      kind,
      bypassActive: enabled,
    });
    for (const descendant of descendants) {
      const bypassActive = resolve(descendant);
      if (previousDescendantStates.get(descendant) !== bypassActive) {
        interactions.setApprovalBypassState({
          streamId: descendant,
          kind,
          bypassActive,
        });
      }
    }
  };

  return {
    isBypassed: resolve,
    setBypass,
    clearForStream(streamId) {
      byStream.delete(streamId);
    },
    clearAll() {
      byStream.clear();
    },
  };
}

/**
 * One queued approval. `bypassed` exists because the queue can hold a request
 * behind another stream prompt for arbitrarily long: if the user turns the
 * stream's bypass on while this one waits (typically by answering the prompt
 * ahead of it with "approve and stop asking"), prompting anyway would ignore
 * the decision they just made.
 */
interface QueuedApproval<T> {
  /** Present the prompt and settle it. */
  readonly prompt: () => Promise<T>;
  /** Result used instead when the stream is bypassed by dispatch time. */
  readonly bypassed: () => T | Promise<T>;
}

interface StreamApprovalController {
  bypass: StreamApprovalBypass;
  /**
   * Serialize one prompt at a time per stream, re-checking the stream's bypass
   * at dispatch rather than at enqueue.
   */
  enqueue<T>(
    streamId: StreamTabId | undefined,
    approval: QueuedApproval<T>,
  ): Promise<T>;
}

interface StreamApprovalControllerOptions {
  kind: ApprovalBypassKind;
  interactions: Pick<SessionHostInteractions, 'setApprovalBypassState'>;
  resolveParent: (streamId: StreamTabId) => StreamTabId | undefined;
  resolveDescendants: (streamId: StreamTabId) => readonly StreamTabId[];
}

function createStreamApprovalController(
  options: StreamApprovalControllerOptions,
): StreamApprovalController {
  const queues = new Map<StreamTabId | undefined, PQueue>();
  const bypass = createStreamApprovalBypass(
    options.kind,
    options.interactions,
    options.resolveParent,
    options.resolveDescendants,
  );

  return {
    bypass,
    enqueue<T>(
      streamId: StreamTabId | undefined,
      approval: QueuedApproval<T>,
    ): Promise<T> {
      let queue = queues.get(streamId);
      if (!queue) {
        queue = new PQueue({ concurrency: 1 });
        queues.set(streamId, queue);
      }

      // `add` widens to `T | void` to cover abort via signal/timeout; we pass
      // neither, so the task always runs and resolves with `T`.
      const task = queue.add(async () =>
        streamId && bypass.isBypassed(streamId)
          ? approval.bypassed()
          : approval.prompt(),
      ) as Promise<T>;
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
  };
}

/**
 * Session-owned approval state: the tool-edit and bash controllers plus the
 * delegation-proposal (super-YOLO) bypass. One instance per `SessionHandle`
 * (`session.approvals`); run-scoped code resolves it through
 * `currentSession()`, host code passes its own session explicitly.
 */
export interface SessionApprovals {
  readonly toolEdit: StreamApprovalController;
  readonly bash: StreamApprovalController;
  /**
   * Per-stream bypass for agent delegation proposals (super-YOLO). Proposals
   * settle through the run coordinators rather than a stream approval queue,
   * so unlike bash / tool-edit there is no controller — only bypass state.
   */
  readonly proposal: StreamApprovalBypass;
  /**
   * Set the complete delegated-task approval mode for one stream: later
   * delegation proposals, file edits, and commands are all approved for it.
   *
   * This is the shared meaning of the extension's legacy "Super Yolo"
   * control. Approval state is session-owned, so the grant cannot leak to
   * another CLI, extension, or desktop session.
   */
  setDelegatedWorkBypasses(streamId: StreamTabId, enabled: boolean): void;
  /**
   * Record that `childStreamId` descends from `parentStreamId`: every bypass
   * kind defers to the parent's state whenever the child has no explicit
   * value of its own.
   *
   * Used for delegated subagent streams (parent = the orchestrator stream, so
   * complete delegated-task approval remains effective through nested
   * orchestrators; see `configureDelegatedChildApprovals`) and, in the CLI,
   * successive conversation rounds (parent = the previous round's root
   * stream, so a round carries forward whichever bypasses were on) — both
   * mint a fresh `StreamTabId` that would otherwise start every bypass kind
   * ungated.
   */
  registerStreamParent(
    childStreamId: StreamTabId,
    parentStreamId: StreamTabId,
  ): void;
  /**
   * Promote a stream out of its approval ancestry while preserving each
   * effective bypass value as an explicit value on the stream.
   */
  detachStreamFromParent(streamId: StreamTabId): void;
  /**
   * Drop `streamId` from the ancestry graph. Direct children are first
   * promoted through {@link detachStreamFromParent}, preserving their
   * effective values before the torn-down parent's own values are cleared.
   */
  forgetStreamAncestry(streamId: StreamTabId): void;
  /**
   * Clear all bypass + proposal + ancestry state for this session.
   */
  clearAll(): void;
}

export function createSessionApprovals(
  interactions: Pick<
    SessionHostInteractions,
    'setApprovalBypassState'
  > = new SessionHostInteractions(),
): SessionApprovals {
  // One ancestry graph shared by every bypass kind. The sole delegation entry
  // point (`configureDelegatedChildApprovals`) and the CLI's round linking
  // both register all kinds at once, so a per-kind subset link is not
  // representable — the bypass *values* stay independent per kind, only the
  // parent edge is shared.
  const parentOf = new Map<StreamTabId, StreamTabId>();
  const resolveParent = (streamId: StreamTabId): StreamTabId | undefined =>
    parentOf.get(streamId);
  const resolveDescendants = (
    streamId: StreamTabId,
  ): readonly StreamTabId[] => {
    const descendants: StreamTabId[] = [];
    const pending = [streamId];
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

  const toolEdit = createStreamApprovalController({
    kind: 'toolEdit',
    interactions,
    resolveParent,
    resolveDescendants,
  });
  const bash = createStreamApprovalController({
    kind: 'bash',
    interactions,
    resolveParent,
    resolveDescendants,
  });
  const proposal = createStreamApprovalBypass(
    'superYolo',
    interactions,
    resolveParent,
    resolveDescendants,
  );
  const bypassByKind: Record<BypassAncestryKind, StreamApprovalBypass> = {
    toolEdit: toolEdit.bypass,
    bash: bash.bypass,
    proposal,
  };

  function detachStreamFromParent(streamId: StreamTabId): void {
    if (!parentOf.has(streamId)) return;
    // Capture every kind's inherited value before the edge goes away, then
    // pin each one as the stream's own explicit value.
    const effectiveValues = ALL_BYPASS_ANCESTRY_KINDS.map(
      (kind) => [kind, bypassByKind[kind].isBypassed(streamId)] as const,
    );
    parentOf.delete(streamId);
    for (const [kind, effectiveValue] of effectiveValues) {
      bypassByKind[kind].setBypass(streamId, effectiveValue, { silent: true });
    }
  }

  return {
    toolEdit,
    bash,
    proposal,
    setDelegatedWorkBypasses(streamId, enabled) {
      proposal.setBypass(streamId, enabled);
      // Unconditional: write the stream's own explicit tool-edit entry even
      // when `isBypassed` already reports true, because that can be an
      // ancestry-resolved inheritance from the parent — super-YOLO granted
      // here must survive the parent later re-gating its own edits.
      toolEdit.bypass.setBypass(streamId, enabled);
      bash.bypass.setBypass(streamId, enabled);
    },
    registerStreamParent(childStreamId, parentStreamId) {
      parentOf.set(childStreamId, parentStreamId);
    },
    detachStreamFromParent,
    forgetStreamAncestry(streamId) {
      const directChildren = [...parentOf]
        .filter(([, parent]) => parent === streamId)
        .map(([child]) => child);
      for (const child of directChildren) detachStreamFromParent(child);
      parentOf.delete(streamId);
    },
    clearAll() {
      toolEdit.bypass.clearAll();
      bash.bypass.clearAll();
      proposal.clearAll();
      parentOf.clear();
    },
  };
}
