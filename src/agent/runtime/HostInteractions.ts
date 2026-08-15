import { createChannelTrace } from '@agent/trace';
import type { ReviewIssueReport } from '@agent/review/reviewIssues';
import type { ModelCredentialSelection } from '@agent/types/ModelHandlerContracts';
import type {
  AgentProposal,
  FileLocation,
  Plan,
  ProgressPermissionKind as PendingInteractionKind,
  RetryPermission,
  StreamTabId,
  UserQuestionAnswers,
  ExternalInquiryPermission,
  UserQuestionPermission,
} from '@shared/schemas';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import { SESSION_DISPOSED_CAUSE } from '@shared/copy/interactionCancellation';
import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { createListenerSet, type ListenerSet } from '@utils/core/listenerSet';
import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';
import type {
  AgentRuntimeEmitOptions,
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from './runtimePresentationEvents';

export type { ProgressPermissionKind as PendingInteractionKind } from '@shared/schemas';

const logger = createChannelTrace('SessionHostInteractions');

/**
 * Ceiling on presentation notices queued while no host is attached. A session
 * that never gets one (headless embedders, a window that never opens) would
 * otherwise accumulate every replayable notice for its whole lifetime. The
 * newest notices are the ones worth showing, so the oldest is dropped, and the
 * drop is logged, because a silently discarded notice is a defect.
 */
const MAX_PENDING_PRESENTATION_REPLAYS = 256;

export type DiagnosticsReader = (path: string) => Promise<GenericDiagnostic[]>;

export interface ManualCriticismEntry {
  /** Absolute path resolved by the diagnostics tool. */
  readonly absolutePath: string;
  /** 1-based line number. */
  readonly line: number;
  readonly message: string;
  /** 0-5; mapped to DiagnosticSeverity by the host. */
  readonly severity: number;
  /** 1-5; appended to the message as `(S/C)`. */
  readonly confidence: number;
}

export type AddCriticismSink = (input: ManualCriticismEntry) => {
  readonly accepted: boolean;
  readonly resolvedPath: string;
};

export interface OpenPdfRequest {
  readonly location: FileLocation;
  readonly preserveFocus: boolean;
}

export type OpenPdfOpener = (request: OpenPdfRequest) => Promise<void> | void;

/**
 * Collects one agent-review finding. Returns `accepted: false` with a reason
 * when no review session is collecting issues (or the report is rejected), so
 * the tool can surface that to the agent.
 */
export type ReportReviewIssueSink = (report: ReviewIssueReport) => {
  readonly accepted: boolean;
  readonly reason?: string;
};

export interface HostInteractionOptions {
  /** Internal identity used to cancel one forwarded presentation request. */
  readonly cancellationScope?: object;
}

export interface HostRetryInteractionOptions extends HostInteractionOptions {
  /**
   * Rebuild the caller's model client after a host-side credential change.
   * A host that calls this successfully has prepared the next attempt; a
   * rejection leaves the caller's previous client unchanged.
   */
  readonly prepareRetry?: (
    selection: ModelCredentialSelection,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export type PlanApprovalResult =
  | { action: 'approve'; feedback?: never; reason?: never; cause?: never }
  | {
      action: 'approve_and_goal';
      feedback?: never;
      reason?: never;
      cause?: never;
    }
  | { action: 'reject'; feedback?: string; reason?: never; cause?: never }
  | { action: 'reject'; reason: string; feedback?: never; cause?: never }
  | {
      action: 'reject';
      cause: string | undefined;
      feedback?: never;
      reason?: never;
    };

export type ProposalResult =
  | {
      action: 'approve';
      model?: string;
      agent?: string;
      feedback?: never;
      reason?: never;
      cause?: never;
    }
  | {
      action: 'reject';
      feedback?: string;
      reason?: never;
      cause?: never;
      model?: never;
      agent?: never;
    }
  | {
      action: 'reject';
      reason: string;
      feedback?: never;
      cause?: never;
      model?: never;
      agent?: never;
    }
  | {
      action: 'reject';
      cause: string | undefined;
      feedback?: never;
      reason?: never;
      model?: never;
      agent?: never;
    }
  | {
      action: 'setup';
      model?: never;
      agent?: never;
      feedback?: never;
      reason?: never;
      cause?: never;
    };

export type RetrySettlement =
  | {
      action: 'retry';
      feedback?: string;
      reason?: never;
      /** Omitted by interactive hosts, which default to a human decision. */
      decisionSource?: 'human' | 'automatic';
    }
  | { action: 'cancel'; feedback?: never; reason?: never };

export type RetryResult =
  | RetrySettlement
  // Policy/headless auto-denial: the retry could not be approved because no
  // human input was available (e.g. `--approval-policy never --no-input`).
  // Distinct from a user `cancel` so retry-exhaustion with no human lands in
  // the `failed` fallback (→ RUN_OUTCOME.FAILED) instead of `cancelled`. See #7331.
  | { action: 'deny'; reason?: string; feedback?: never };

export interface HostPlanApprovalRequest {
  readonly approvalId: string;
  readonly streamId: StreamTabId;
  readonly plan: Plan;
  readonly goalEnabled: boolean;
}

export interface HostBashApprovalRequest {
  readonly command: string;
  readonly cwd?: string | null;
  readonly streamId?: StreamTabId | null;
}

export type HostAgentProposalRequest = AgentProposal & {
  readonly proposalId: string;
  readonly streamId: StreamTabId;
};

/**
 * The retry payload the runtime hands to hosts. This is deliberately an alias
 * of the shared {@link RetryPermission} schema so the runtime and every host
 * render the same contract; a field added to the permission payload is
 * available here without a hand-maintained mirror.
 */
export type HostRetryRequest = RetryPermission;

export type HostUserQuestionRequest = UserQuestionPermission;

export interface HostInteractionResultByKind {
  readonly bash: BashSettlement;
  readonly planApproval: PlanApprovalResult;
  readonly proposal: ProposalResult;
  readonly retry: RetryResult;
  readonly userQuestion: UserQuestionSettlement;
}

export type HostExternalInquiryRequest = ExternalInquiryPermission;

export interface HostExternalInquiryHandle {
  readonly threadId: string;
}

export type BashSettlement =
  | { readonly action: 'approve'; readonly feedback?: never }
  | {
      readonly action: 'reject';
      readonly feedback?: string;
      readonly reason?: never;
      readonly cause?: never;
    }
  | {
      readonly action: 'reject';
      readonly reason: string;
      readonly feedback?: never;
      readonly cause?: never;
    }
  | {
      readonly action: 'reject';
      readonly cause: string | undefined;
      readonly feedback?: never;
      readonly reason?: never;
    };

export type UserQuestionSettlement =
  | {
      readonly action: 'submit';
      readonly answers: UserQuestionAnswers;
      readonly feedback?: never;
      readonly reason?: never;
      readonly cause?: never;
    }
  | {
      readonly action: 'reject' | 'skip';
      readonly feedback?: string;
      readonly answers?: never;
      readonly reason?: never;
      readonly cause?: never;
    }
  | {
      readonly action: 'reject';
      readonly reason: string;
      readonly feedback?: never;
      readonly answers?: never;
      readonly cause?: never;
    }
  | {
      readonly action: 'reject';
      readonly cause: string | undefined;
      readonly feedback?: never;
      readonly answers?: never;
      readonly reason?: never;
    };

/**
 * Every "reject" result variant above shares this same field-presence
 * encoding: a `cause` key means the host cancelled the request, a `reason`
 * key means a policy denied it, and only a `feedback` key means the user
 * actually rejected it. {@link classifyRejection} is the one place that
 * reads the field presence, so consumers switch on `kind` instead of each
 * re-deriving the `'cause' in result` / `'reason' in result` cascade.
 */
type RejectionClassification =
  | { readonly kind: 'cancelled'; readonly cause: string | undefined }
  | { readonly kind: 'policy'; readonly reason: string }
  | { readonly kind: 'feedback'; readonly feedback?: string };

export function classifyRejection(result: {
  readonly feedback?: string;
  readonly reason?: string;
  readonly cause?: string;
}): RejectionClassification {
  if ('cause' in result) return { kind: 'cancelled', cause: result.cause };
  // Nullish, not presence: the four concrete result unions above type
  // `reason` as a required, non-optional `string` on the policy variant,
  // but this function's parameter type is intentionally looser (shared
  // across all four) and `HostInteractions` is an extension boundary —
  // JS/headless embedders can hand back `{ reason: undefined }`. Treating
  // that as "policy" would need a fake value (every consumer calls
  // `.trim()` on `reason` unconditionally); falling through to `feedback`
  // instead matches what the pre-refactor sites did with this shape.
  if (result.reason != null) return { kind: 'policy', reason: result.reason };
  return { kind: 'feedback', feedback: result.feedback };
}

export type SettledInteractionKind = keyof HostInteractionResultByKind;

type CancellationResultFactories = {
  [K in SettledInteractionKind]: (
    cause?: string,
  ) => HostInteractionResultByKind[K];
};

const cancellationResultFactories: CancellationResultFactories = {
  bash: (cause) => ({ action: 'reject', cause: cause?.trim() }),
  planApproval: (cause) => ({ action: 'reject', cause }),
  proposal: (cause) => ({ action: 'reject', cause }),
  retry: () => ({ action: 'cancel' }),
  userQuestion: (cause) => ({ action: 'reject', cause }),
};

/** Typed cancellation result shared by every presenting host. */
export function cancellationResultFor<K extends SettledInteractionKind>(
  kind: K,
  cause?: string,
): HostInteractionResultByKind[K] {
  return cancellationResultFactories[kind](cause);
}

export interface HostApprovalBypassStateUpdate {
  readonly streamId: StreamTabId;
  readonly kind: ApprovalBypassKind;
  readonly bypassActive: boolean;
}

/**
 * Selector for {@link HostInteractions.cancel}.
 *
 * - `{}` — cancel every pending request.
 * - `{ kind }` — cancel every pending request of that kind.
 * - `{ streamId }` — cancel every pending request on that stream.
 * - `{ streamId, kind }` — cancel that kind on that stream.
 * - `streamId: null` — cancel only requests with no concrete stream
 *   (the streamless/unscoped sweep).
 */
export interface HostInteractionCancelSelector {
  readonly streamId?: StreamTabId | null;
  readonly kind?: PendingInteractionKind;
  readonly cause?: string;
  /** Internal identity for one forwarded presentation request. */
  readonly cancellationScope?: object;
}

/** Shared selector predicate for the ports' pending registries. */
export function matchesCancelSelector(
  pending: {
    readonly kind: PendingInteractionKind;
    readonly streamId?: StreamTabId;
    readonly cancellationScope?: object;
  },
  selector: HostInteractionCancelSelector,
): boolean {
  if (selector.kind !== undefined && pending.kind !== selector.kind) {
    return false;
  }
  if (
    selector.cancellationScope !== undefined &&
    pending.cancellationScope !== selector.cancellationScope
  ) {
    return false;
  }
  if (selector.streamId === undefined) return true;
  if (selector.streamId === null) return !pending.streamId;
  return pending.streamId === selector.streamId;
}

/**
 * Session-owned host interaction surface.
 *
 * Runtime code asks the session for an interaction. The session owns the
 * request until it settles or is explicitly cancelled, while concrete host
 * adapters own presentation, request-id resolution, and local disposal.
 */
export interface HostInteractions {
  /**
   * Present a runtime event through the active host attachment. A host that
   * renders the event returns `true` (or a `Promise<true>` once rendered);
   * a host that ignores it or cannot deliver it returns `false`, so callers
   * can keep a fallback surface instead of assuming fire-and-forget delivery.
   */
  emit?<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
  ): boolean | Promise<boolean>;
  /** Read diagnostics from the active host integration. */
  readonly readDiagnostics?: DiagnosticsReader;
  /** Add one manual criticism to the active host diagnostics surface. */
  readonly addCriticism?: AddCriticismSink;
  /** Open a PDF in the active host's viewer. */
  readonly openPdf?: OpenPdfOpener;
  /** Report one agent-review finding to the active host's review session. */
  readonly reportReviewIssue?: ReportReviewIssueSink;
  /** Present non-error information through the currently attached host. */
  showInfoMessage?(message: string): Promise<void> | void;
  requestToolEditApproval?(
    request: ToolEditApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<ToolEditApprovalResult> | undefined;
  requestBashApproval?(
    request: HostBashApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<BashSettlement> | undefined;
  requestPlanApproval?(
    request: HostPlanApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<PlanApprovalResult> | undefined;
  requestAgentProposal?(
    request: HostAgentProposalRequest,
    options?: HostInteractionOptions,
  ): Promise<ProposalResult> | undefined;
  requestRetry?(
    request: HostRetryRequest,
    options?: HostRetryInteractionOptions,
  ): Promise<RetryResult> | undefined;
  askUserQuestion?(
    request: HostUserQuestionRequest,
    options?: HostInteractionOptions,
  ): Promise<UserQuestionSettlement> | undefined;
  openExternalInquiry?(
    request: HostExternalInquiryRequest,
  ): Promise<HostExternalInquiryHandle> | undefined;
  setApprovalBypassState?(update: HostApprovalBypassStateUpdate): void;
  /** Settle pending requests matching the selector with their reject/cancel defaults. */
  cancel(selector?: HostInteractionCancelSelector): void;
  dispose?(): void;
}

interface HostInteractionAttachment {
  readonly interactions: HostInteractions;
  disposed: boolean;
}

interface PendingSessionInteraction {
  readonly kind: PendingInteractionKind;
  readonly streamId?: StreamTabId;
  readonly dispatch: (
    interactions: HostInteractions,
  ) => Promise<unknown> | undefined;
  readonly cancellationResult: (cause?: string) => unknown;
  readonly settle: (result: unknown) => void;
  readonly reject: (reason?: unknown) => void;
  cancellationRequested: boolean;
}

/**
 * Stable per-session interaction owner. The `SessionHandle` exposes this
 * object once, while hosts may attach and detach presentation adapters without
 * cancelling requests owned by a still-running session.
 */
export class SessionHostInteractions implements HostInteractions {
  private readonly attachments: HostInteractionAttachment[] = [];
  private readonly pending = new Set<PendingSessionInteraction>();
  private readonly pendingCountListeners: ListenerSet<(count: number) => void> =
    createListenerSet();
  private readonly pendingPresentationReplays: Array<
    (interactions: HostInteractions) => unknown
  > = [];
  private attachmentVersion = 0;
  private disposed = false;

  /** Number of response-bearing requests awaiting a host decision. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Observe transitions between no pending requests and at least one. */
  onPendingCountChange(listener: (count: number) => void): () => void {
    if (this.disposed) return () => {};
    return this.pendingCountListeners.add(listener);
  }

  use(interactions: HostInteractions): () => void {
    if (this.disposed) {
      interactions.dispose?.();
      return () => {};
    }
    const previous = this.activeAttachment;
    const attachment: HostInteractionAttachment = {
      interactions,
      disposed: false,
    };
    this.attachments.push(attachment);
    this.activateCurrentAttachment(previous);
    queueMicrotask(() => this.replayPendingPresentations(attachment));
    return () => {
      if (attachment.disposed) return;
      const wasActive = this.activeAttachment === attachment;
      attachment.disposed = true;
      const index = this.attachments.indexOf(attachment);
      if (index !== -1) this.attachments.splice(index, 1);
      if (wasActive) this.activateCurrentAttachment(attachment);
      interactions.dispose?.();
    };
  }

  emit<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
    options: AgentRuntimeEmitOptions = {},
  ): boolean | Promise<boolean> {
    const active = this.activeAttachment;
    if (active) {
      try {
        return active.interactions.emit?.(event, payload) ?? false;
      } catch (error) {
        logger.warn('Live presentation emit failed', { data: error });
        return false;
      }
    }
    if (options.replayWhenAttached && !this.disposed) {
      // A retained replay is not delivery: nothing has been rendered yet, so
      // the caller must not treat this as confirmed presentation. The replay
      // closure reports the eventual delivery result back through the
      // option callbacks once a live host actually renders (or declines) it.
      this.queuePresentationReplay((interactions) => {
        if (!options.onReplayDelivered && !options.onReplayNotDelivered) {
          return interactions.emit?.(event, payload);
        }
        // A synchronous throw from the host's emit (a desktop renderer post
        // during teardown, a development assertion) escapes the promise
        // chain below and would otherwise be caught only by the replay
        // loop's warn-log, leaving the caller's presentation-pending marker
        // stuck and the failure surfaced zero times. Route it through the
        // same not-delivered fallback as a returned `false` or a rejection.
        let delivered: boolean | Promise<boolean> | undefined;
        try {
          delivered = interactions.emit?.(event, payload);
        } catch (error) {
          logger.warn('Replayed presentation notice failed', {
            data: error,
          });
          options.onReplayNotDelivered?.(interactions);
          return undefined;
        }
        return Promise.resolve(delivered).then(
          (value) => {
            if (value === true) {
              options.onReplayDelivered?.();
            } else {
              options.onReplayNotDelivered?.(interactions);
            }
          },
          (error: unknown) => {
            logger.warn('Replayed presentation notice failed', {
              data: error,
            });
            options.onReplayNotDelivered?.(interactions);
          },
        );
      });
      options.onReplayScheduled?.();
      return false;
    }
    return false;
  }

  get readDiagnostics(): DiagnosticsReader | undefined {
    return this.activeAttachment?.interactions.readDiagnostics;
  }

  get addCriticism(): AddCriticismSink | undefined {
    return this.activeAttachment?.interactions.addCriticism;
  }

  get openPdf(): OpenPdfOpener | undefined {
    return this.activeAttachment?.interactions.openPdf;
  }

  get reportReviewIssue(): ReportReviewIssueSink | undefined {
    return this.activeAttachment?.interactions.reportReviewIssue;
  }

  showInfoMessage(
    message: string,
    options: AgentRuntimeEmitOptions = {},
  ): Promise<void> | void {
    const active = this.activeAttachment;
    if (active) return active.interactions.showInfoMessage?.(message);
    if (options.replayWhenAttached && !this.disposed) {
      this.queuePresentationReplay((interactions) =>
        interactions.showInfoMessage?.(message),
      );
    }
  }

  requestToolEditApproval(
    request: ToolEditApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<ToolEditApprovalResult> {
    return this.enqueue<ToolEditApprovalResult>(
      'toolEdit',
      request.streamId as StreamTabId | null | undefined,
      (interactions) =>
        interactions.requestToolEditApproval?.(request, options),
      (cause) => ({ accepted: false, cause }),
    );
  }

  requestBashApproval(
    request: HostBashApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<BashSettlement> {
    return this.enqueue<BashSettlement>(
      'bash',
      request.streamId ?? undefined,
      (interactions) => interactions.requestBashApproval?.(request, options),
      (cause) => cancellationResultFor('bash', cause),
    );
  }

  requestPlanApproval(
    request: HostPlanApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<PlanApprovalResult> {
    return this.enqueue<PlanApprovalResult>(
      'planApproval',
      request.streamId,
      (interactions) => interactions.requestPlanApproval?.(request, options),
      (cause) => cancellationResultFor('planApproval', cause),
    );
  }

  requestAgentProposal(
    request: HostAgentProposalRequest,
    options?: HostInteractionOptions,
  ): Promise<ProposalResult> {
    return this.enqueue<ProposalResult>(
      'proposal',
      request.streamId,
      (interactions) => interactions.requestAgentProposal?.(request, options),
      (cause) => cancellationResultFor('proposal', cause),
    );
  }

  requestRetry(
    request: HostRetryRequest,
    options?: HostRetryInteractionOptions,
  ): Promise<RetryResult> {
    return this.enqueue<RetryResult>(
      'retry',
      request.streamId,
      (interactions) => interactions.requestRetry?.(request, options),
      (cause) => cancellationResultFor('retry', cause),
    );
  }

  askUserQuestion(
    request: HostUserQuestionRequest,
    options?: HostInteractionOptions,
  ): Promise<UserQuestionSettlement> {
    return this.enqueue<UserQuestionSettlement>(
      'userQuestion',
      request.streamId || undefined,
      (interactions) => interactions.askUserQuestion?.(request, options),
      (cause) => cancellationResultFor('userQuestion', cause),
    );
  }

  openExternalInquiry(
    request: HostExternalInquiryRequest,
  ): Promise<HostExternalInquiryHandle> | undefined {
    // Opening an inquiry is a notification whose tool contract returns
    // immediately; it is not a response-bearing approval. Preserve the
    // existing loud unavailable path instead of parking the agent while no UI
    // is attached.
    return this.activeAttachment?.interactions.openExternalInquiry?.(request);
  }

  setApprovalBypassState(update: HostApprovalBypassStateUpdate): void {
    this.activeAttachment?.interactions.setApprovalBypassState?.(update);
  }

  cancel(selector: HostInteractionCancelSelector = {}): void {
    const matching = [...this.pending].filter((pending) =>
      matchesCancelSelector(pending, selector),
    );
    for (const pending of matching) pending.cancellationRequested = true;

    const settleFallbacks = (): void => {
      for (const pending of matching) {
        if (!this.deletePending(pending)) continue;
        pending.settle(pending.cancellationResult(selector.cause));
      }
    };
    const active = this.activeAttachment;
    try {
      active?.interactions.cancel(selector);
    } finally {
      if (active) queueMicrotask(settleFallbacks);
      else settleFallbacks();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const cancellationCause = SESSION_DISPOSED_CAUSE;
    let firstError: unknown;
    try {
      this.cancel({ cause: cancellationCause });
    } catch (error) {
      firstError = error;
    }
    // An attached adapter makes cancel's fallback asynchronous so that its
    // own settlement can win. Session disposal is terminal, however: settle
    // any requests still owned here before observers are removed.
    for (const pending of [...this.pending]) {
      if (!this.deletePending(pending)) continue;
      pending.settle(pending.cancellationResult(cancellationCause));
    }
    this.attachmentVersion += 1;
    for (const attachment of this.attachments.toReversed()) {
      if (attachment.disposed) continue;
      attachment.disposed = true;
      try {
        attachment.interactions.dispose?.();
      } catch (error) {
        firstError ??= error;
      }
    }
    this.attachments.length = 0;
    this.pendingPresentationReplays.length = 0;
    this.pendingCountListeners.clear();
    if (firstError !== undefined) throw firstError;
  }

  private get activeAttachment(): HostInteractionAttachment | undefined {
    return this.attachments.at(-1);
  }

  private enqueue<TResult>(
    kind: PendingInteractionKind,
    streamId: StreamTabId | null | undefined,
    dispatch: (interactions: HostInteractions) => Promise<TResult> | undefined,
    cancellationResult: (cause?: string) => TResult,
  ): Promise<TResult> {
    if (this.disposed) {
      return Promise.resolve(cancellationResult());
    }

    return new Promise<TResult>((resolve, reject) => {
      const pending: PendingSessionInteraction = {
        kind,
        streamId: streamId ?? undefined,
        dispatch,
        cancellationResult,
        settle: (result) => resolve(result as TResult),
        reject,
        cancellationRequested: false,
      };
      this.pending.add(pending);
      if (this.pending.size === 1) this.notifyPendingCountChange();
      this.dispatch(pending);
    });
  }

  private activateCurrentAttachment(
    previous: HostInteractionAttachment | undefined,
  ): void {
    this.attachmentVersion += 1;
    const active = this.activeAttachment;
    if (previous && previous !== active) {
      try {
        previous.interactions.cancel({ cause: 'Interaction host changed.' });
      } catch (error) {
        logger.warn('Failed to cancel the previous interaction host', {
          data: error,
        });
      }
    }
    if (!active) {
      for (const pending of this.pending) {
        if (!pending.cancellationRequested) this.warnParked(pending);
      }
      return;
    }
    for (const pending of this.pending) {
      if (!pending.cancellationRequested) this.dispatch(pending);
    }
  }

  private queuePresentationReplay(
    replay: (interactions: HostInteractions) => unknown,
  ): void {
    if (
      this.pendingPresentationReplays.length >= MAX_PENDING_PRESENTATION_REPLAYS
    ) {
      this.pendingPresentationReplays.shift();
      logger.warn(
        `Dropped the oldest queued presentation notice: more than ${MAX_PENDING_PRESENTATION_REPLAYS} ` +
          'notices are waiting for an interaction host to attach.',
      );
    }
    this.pendingPresentationReplays.push(replay);
  }

  private replayPendingPresentations(
    attachment: HostInteractionAttachment,
  ): void {
    while (
      !attachment.disposed &&
      this.activeAttachment === attachment &&
      this.pendingPresentationReplays.length > 0
    ) {
      const replay = this.pendingPresentationReplays.shift();
      if (!replay) return;
      try {
        void Promise.resolve(replay(attachment.interactions)).catch(
          (error: unknown) => {
            logger.warn('Failed to replay a session presentation notice', {
              data: error,
            });
          },
        );
      } catch (error) {
        logger.warn('Failed to replay a session presentation notice', {
          data: error,
        });
      }
    }
  }

  private dispatch(pending: PendingSessionInteraction): void {
    const attachment = this.activeAttachment;
    if (!attachment) {
      this.warnParked(pending);
      return;
    }
    const version = this.attachmentVersion;
    let result: Promise<unknown> | undefined;
    try {
      result = pending.dispatch(attachment.interactions);
    } catch (error) {
      this.rejectCurrentDispatch(pending, attachment, version, error);
      return;
    }
    if (!result) {
      this.deletePending(pending);
      pending.settle(pending.cancellationResult());
      return;
    }
    void result.then(
      (value) => {
        if (!this.isCurrentDispatch(pending, attachment, version)) return;
        this.deletePending(pending);
        pending.settle(value);
      },
      (error: unknown) => {
        this.rejectCurrentDispatch(pending, attachment, version, error);
      },
    );
  }

  private warnParked(pending: PendingSessionInteraction): void {
    try {
      logger.warn(
        `No interaction host is attached: parked the ${pending.kind} request ` +
          `(stream ${pending.streamId ?? 'none'}) until one attaches. A ` +
          'headless embedder must attach at least `{ cancel: () => {} }`, or ' +
          'blocking requests never settle.',
      );
    } catch {
      // A diagnostic sink must not reject or remove the request it describes.
    }
  }

  private rejectCurrentDispatch(
    pending: PendingSessionInteraction,
    attachment: HostInteractionAttachment,
    version: number,
    error: unknown,
  ): void {
    if (!this.isCurrentDispatch(pending, attachment, version)) return;
    this.deletePending(pending);
    pending.reject(error);
  }

  private deletePending(pending: PendingSessionInteraction): boolean {
    if (!this.pending.delete(pending)) return false;
    if (this.pending.size === 0) this.notifyPendingCountChange();
    return true;
  }

  private notifyPendingCountChange(): void {
    for (const listener of this.pendingCountListeners) {
      try {
        listener(this.pending.size);
      } catch (error) {
        logger.warn('Pending interaction observer failed', { data: error });
      }
    }
  }

  private isCurrentDispatch(
    pending: PendingSessionInteraction,
    attachment: HostInteractionAttachment,
    version: number,
  ): boolean {
    return (
      this.pending.has(pending) &&
      this.activeAttachment === attachment &&
      this.attachmentVersion === version
    );
  }
}
