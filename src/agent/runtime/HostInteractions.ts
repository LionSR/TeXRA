import type { ReviewIssueReport } from '@agent/review/reviewIssues';
import type { ModelCredentialSelection } from '@agent/types/ModelHandlerContracts';
import { createLog } from '@logger/logUtils';
import { redactSecrets } from '@logger/redaction';
import type {
  AgentProposalPermission,
  BashPermission,
  FileLocation,
  PermissionPayload,
  PlanApprovalPermission,
  ProgressPermissionKind,
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
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';
import type {
  AgentRuntimeEmitOptions,
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from './runtimePresentationEvents';
import type { SessionHandle } from './SessionHandle';

const logger = createLog('SessionHostInteractions');

/**
 * Ceiling on presentation notices queued while no host is attached. A session
 * that never gets one (headless embedders, a window that never opens) would
 * otherwise accumulate every replayable notice for its whole lifetime. The
 * newest notices are the ones worth showing, so the oldest is dropped, and the
 * drop is logged, because a silently discarded notice is a defect.
 */
const MAX_PENDING_PRESENTATION_REPLAYS = 256;

type DiagnosticsReader = (path: string) => Promise<GenericDiagnostic[]>;

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

type AddCriticismSink = (input: ManualCriticismEntry) => {
  readonly accepted: boolean;
  readonly resolvedPath: string;
};

interface OpenPdfRequest {
  readonly location: FileLocation;
  readonly preserveFocus: boolean;
}

type OpenPdfOpener = (request: OpenPdfRequest) => Promise<void> | void;

/**
 * Collects one agent-review finding. Returns `accepted: false` with a reason
 * when no review session is collecting issues (or the report is rejected), so
 * the tool can surface that to the agent.
 */
type ReportReviewIssueSink = (report: ReviewIssueReport) => {
  readonly accepted: boolean;
  readonly reason?: string;
};

export interface HostRetryInteractionOptions {
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

/**
 * The human-declined channel of {@link RejectionProvenance}: optional text the
 * user typed while declining, addressed to the agent.
 */
type UserDeclinedProvenance = {
  readonly feedback?: string;
  readonly reason?: never;
  readonly cause?: never;
};

/**
 * Why a settled interaction is a rejection. Exactly one channel is ever
 * populated, which is what lets every consumer tell "the user said no" apart
 * from "policy denied it" and "nobody was left to ask" without a second
 * discriminator:
 *
 * - `feedback` — a human declined and left instructions for the agent.
 * - `reason` — a policy/headless denial message; no human was available.
 * - `cause` — an automatic cancellation (run ended, session disposed);
 *   `undefined` when the canceller supplied none.
 *
 * Declared once and consumed by every rejectable settlement, so a new
 * provenance channel cannot reach one settlement kind and miss another.
 */
export type RejectionProvenance =
  | UserDeclinedProvenance
  | {
      readonly reason: string;
      readonly feedback?: never;
      readonly cause?: never;
    }
  | {
      readonly cause: string | undefined;
      readonly feedback?: never;
      readonly reason?: never;
    };

/** The counterpart for settlement arms that are not rejections. */
type NoRejectionProvenance = {
  readonly feedback?: never;
  readonly reason?: never;
  readonly cause?: never;
};

export type PlanApprovalResult =
  | ({ action: 'approve' } & NoRejectionProvenance)
  | ({
      action: 'approve_and_goal';
      /** Auto-approve commands, edits, and delegated work for this goal. */
      autoApproveAll?: true;
    } & NoRejectionProvenance)
  | ({ action: 'reject' } & RejectionProvenance);

export type ProposalResult =
  | ({
      action: 'approve';
      model?: string;
      agent?: string;
    } & NoRejectionProvenance)
  | ({ action: 'reject'; model?: never; agent?: never } & RejectionProvenance)
  | ({
      action: 'setup';
      model?: never;
      agent?: never;
    } & NoRejectionProvenance);

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

/**
 * The plan-approval payload the runtime hands to hosts. This is deliberately
 * an alias of the type inferred from `PlanApprovalPermissionSchema` so the
 * runtime and every host render the same contract; a field added to the
 * permission payload is available here without a hand-maintained mirror.
 */
export type HostPlanApprovalRequest = Readonly<PlanApprovalPermission>;

export interface HostBashApprovalRequest {
  readonly command: string;
  readonly cwd?: string | null;
  readonly streamId?: StreamTabId | null;
  /**
   * What the UI shows for this request, built once at the tool boundary
   * (`prepareBashApprovalPrompt`): the payload of the `approval.requested`
   * fact, and what every host surface renders.
   */
  readonly permission: BashPermission;
}

/**
 * Host-facing proposal request. Reuses the canonical permission payload while
 * preserving the readonly host-interaction contract.
 */
export type HostAgentProposalRequest = Readonly<AgentProposalPermission>;

/**
 * The retry payload the runtime hands to hosts. This is deliberately an alias
 * of the shared {@link RetryPermission} schema so the runtime and every host
 * render the same contract; a field added to the permission payload is
 * available here without a hand-maintained mirror.
 */
export type HostRetryRequest = RetryPermission;

export type HostUserQuestionRequest = UserQuestionPermission;

interface HostInteractionResultByKind {
  readonly bash: BashSettlement;
  readonly planApproval: PlanApprovalResult;
  readonly proposal: ProposalResult;
  readonly retry: RetryResult;
  readonly toolEdit: ToolEditApprovalResult;
  readonly userQuestion: UserQuestionSettlement;
}

type HostExternalInquiryRequest = ExternalInquiryPermission;

export type BashSettlement =
  | ({ readonly action: 'approve' } & NoRejectionProvenance)
  | ({ readonly action: 'reject' } & RejectionProvenance);

export type UserQuestionSettlement =
  | ({
      readonly action: 'submit';
      readonly answers: UserQuestionAnswers;
    } & NoRejectionProvenance)
  // Skipping is always the user's own decision, so it carries no policy or
  // cancellation provenance — only a rejection can.
  | ({
      readonly action: 'reject' | 'skip';
      readonly answers?: never;
    } & UserDeclinedProvenance)
  | ({
      readonly action: 'reject';
      readonly answers?: never;
    } & RejectionProvenance);

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
  toolEdit: (cause) => ({ action: 'reject', cause }),
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
  readonly kind?: ProgressPermissionKind;
  readonly cause?: string;
}

/** Shared selector predicate for the ports' pending registries. */
export function matchesCancelSelector(
  pending: {
    readonly kind: ProgressPermissionKind;
    readonly streamId?: StreamTabId;
  },
  selector: HostInteractionCancelSelector,
): boolean {
  if (selector.kind !== undefined && pending.kind !== selector.kind) {
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
  requestToolEditApproval?(
    request: ToolEditApprovalRequest,
  ): Promise<ToolEditApprovalResult> | undefined;
  requestBashApproval?(
    request: HostBashApprovalRequest,
  ): Promise<BashSettlement> | undefined;
  requestPlanApproval?(
    request: HostPlanApprovalRequest,
  ): Promise<PlanApprovalResult> | undefined;
  requestAgentProposal?(
    request: HostAgentProposalRequest,
  ): Promise<ProposalResult> | undefined;
  requestRetry?(
    request: HostRetryRequest,
    options?: HostRetryInteractionOptions,
  ): Promise<RetryResult> | undefined;
  askUserQuestion?(
    request: HostUserQuestionRequest,
  ): Promise<UserQuestionSettlement> | undefined;
  openExternalInquiry?(
    request: HostExternalInquiryRequest,
  ): Promise<void> | undefined;
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
  readonly kind: ProgressPermissionKind;
  readonly streamId?: StreamTabId;
  /** The `approval.requested` fact this request published, so its
   *  `approval.resolved` names the same request; absent while no session is
   *  bound or the request names no stream. */
  readonly fact?: {
    readonly streamId: StreamTabId;
    readonly requestId: string;
  };
  readonly dispatch: (
    interactions: HostInteractions,
  ) => Promise<unknown> | undefined;
  readonly cancellationResult: (cause?: string) => unknown;
  readonly settle: (result: unknown) => void;
  readonly reject: (reason?: unknown) => void;
  /** A retry's client preparation, forwarded by the run (`prepareRetry`). */
  readonly prepareRetry?: HostRetryInteractionOptions['prepareRetry'];
  cancellationRequested: boolean;
}

/**
 * What the UI shows for one request (PRD one-fold-three-renderers, section
 * 6, item 1): the same permission payload every host publishes to its
 * approval surface, carried by the request itself. Never a host handle.
 * Plans, proposals, retries, and questions are their own permission; bash
 * and tool-edit requests carry the prompt the tool boundary prepared.
 */
type PermissionPayloadFor<K extends SettledInteractionKind> = Extract<
  PermissionPayload,
  { kind: K }
>;

/**
 * The durable copy of a request payload. A retry carries the provider error,
 * whose body can echo the request URL or an `Authorization` header: the
 * transcript rail scrubs those fields at record time
 * (`TexraTranscriptRecorder`), and the fact rail scrubs them here, at its one
 * emission point, dropping the raw body outright. Bash commands and question
 * text are what the user typed and stay as they are.
 */
function redactedForFact(payload: PermissionPayload): PermissionPayload {
  if (payload.kind !== 'retry') return payload;
  const { errorMessage, errorDetails, ...data } = payload.data;
  const redactedDetails = (() => {
    if (!errorDetails) return errorDetails;
    const { rawErrorBody: _dropped, ...details } = errorDetails;
    for (const key of ['message', 'statusText', 'partialText'] as const) {
      const value = details[key];
      if (typeof value === 'string') details[key] = redactSecrets(value);
    }
    return details;
  })();
  return {
    kind: 'retry',
    data: {
      ...data,
      ...(errorMessage === undefined
        ? {}
        : { errorMessage: redactSecrets(errorMessage) }),
      ...(redactedDetails === undefined
        ? {}
        : { errorDetails: redactedDetails }),
    },
  };
}

/**
 * Stable per-session interaction owner. The `SessionHandle` exposes this
 * object once, while hosts may attach and detach presentation adapters without
 * cancelling requests owned by a still-running session.
 */
export class SessionHostInteractions implements HostInteractions {
  private readonly attachments: HostInteractionAttachment[] = [];
  private readonly pending = new Set<PendingSessionInteraction>();
  private readonly pendingPresentationReplays: Array<
    (interactions: HostInteractions) => unknown
  > = [];
  private attachmentVersion = 0;
  private disposed = false;

  /**
   * @param session The owning session: the run-scoped fact rail every
   *   response-bearing request publishes `approval.requested` and
   *   `approval.resolved` on, through `session.publishRunEvent`, never a bus.
   *   `SessionHandle` constructs this surface with itself.
   */
  constructor(private readonly session: SessionHandle) {}

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
        if (!options.onReplayNotDelivered) {
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
            if (value !== true) options.onReplayNotDelivered?.(interactions);
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

  requestToolEditApproval(
    request: ToolEditApprovalRequest,
  ): Promise<ToolEditApprovalResult> {
    return this.enqueue(
      'toolEdit',
      request.streamId,
      (interactions) => interactions.requestToolEditApproval?.(request),
      { kind: 'toolEdit', data: request.permission },
    );
  }

  requestBashApproval(
    request: HostBashApprovalRequest,
  ): Promise<BashSettlement> {
    return this.enqueue(
      'bash',
      request.streamId,
      (interactions) => interactions.requestBashApproval?.(request),
      { kind: 'bash', data: request.permission },
    );
  }

  requestPlanApproval(
    request: HostPlanApprovalRequest,
  ): Promise<PlanApprovalResult> {
    return this.enqueue(
      'planApproval',
      request.streamId,
      (interactions) => interactions.requestPlanApproval?.(request),
      { kind: 'planApproval', data: request },
    );
  }

  requestAgentProposal(
    request: HostAgentProposalRequest,
  ): Promise<ProposalResult> {
    return this.enqueue(
      'proposal',
      request.streamId,
      (interactions) => interactions.requestAgentProposal?.(request),
      { kind: 'proposal', data: request },
    );
  }

  requestRetry(
    request: HostRetryRequest,
    options?: HostRetryInteractionOptions,
  ): Promise<RetryResult> {
    return this.enqueue(
      'retry',
      request.streamId,
      (interactions) => interactions.requestRetry?.(request, options),
      { kind: 'retry', data: request },
      options?.prepareRetry,
    );
  }

  askUserQuestion(
    request: HostUserQuestionRequest,
  ): Promise<UserQuestionSettlement> {
    return this.enqueue(
      'userQuestion',
      request.streamId || undefined,
      (interactions) => interactions.askUserQuestion?.(request),
      { kind: 'userQuestion', data: request },
    );
  }

  openExternalInquiry(
    request: HostExternalInquiryRequest,
  ): Promise<void> | undefined {
    // Opening an inquiry is a notification whose tool contract returns
    // immediately; it is not a response-bearing approval. Preserve the
    // existing loud unavailable path instead of parking the agent while no UI
    // is attached.
    return this.activeAttachment?.interactions.openExternalInquiry?.(request);
  }

  setApprovalBypassState(update: HostApprovalBypassStateUpdate): void {
    this.activeAttachment?.interactions.setApprovalBypassState?.(update);
  }

  /**
   * Settle the pending request `requestId` (the id its `approval.requested`
   * carries) with a decision any surface reached through `runtime.request`
   * (PRD one-fold-three-renderers, 8.2). The pending set is the one owner of
   * outstanding requests, so a decision from a second surface lands on the
   * same request the first one shows. Returns false when no request of that
   * kind is pending under the id: it settled already, or was never made.
   */
  settleRequest<K extends SettledInteractionKind>(
    kind: K,
    requestId: string,
    result: HostInteractionResultByKind[K],
  ): boolean {
    const pending = this.findPending(kind, requestId);
    if (!pending || !this.deletePending(pending)) return false;
    pending.settle(result);
    return true;
  }

  /**
   * Settle a pending retry after the run's client preparation ran on the
   * chosen credentials (`decision.retry`): the preparation is the rebind
   * the run forwarded with its request, so a retry never resumes on a
   * client the host's credential change left stale. A failed preparation
   * settles the request as a denial. False when no such retry is pending
   * once the preparation returns: a cancellation or a newer request under
   * the same id took it.
   */
  async settleRetry(
    requestId: string,
    result: RetrySettlement,
    selection: ModelCredentialSelection = 'configured',
  ): Promise<boolean> {
    const pending = this.findPending('retry', requestId);
    if (!pending) return false;
    if (result.action === 'retry' && pending.prepareRetry) {
      try {
        await pending.prepareRetry(selection);
      } catch (error) {
        return this.settleRequest('retry', requestId, {
          action: 'deny',
          reason: toErrorMessage(error),
        });
      }
    }
    return this.settleRequest('retry', requestId, result);
  }

  private findPending(
    kind: SettledInteractionKind,
    requestId: string,
  ): PendingSessionInteraction | undefined {
    for (const pending of this.pending) {
      if (pending.kind === kind && pending.fact?.requestId === requestId) {
        return pending;
      }
    }
    return undefined;
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
    if (firstError !== undefined) throw firstError;
  }

  private get activeAttachment(): HostInteractionAttachment | undefined {
    return this.attachments.at(-1);
  }

  /**
   * Register one response-bearing request. Its cancellation fallback is
   * derived from `kind` through {@link cancellationResultFor} rather than
   * supplied beside it, so a request can never be paired with another kind's
   * cancellation result, and the settled type follows the same key.
   *
   * A request for a stream is a run fact: `approval.requested` is published
   * before the host sees it, and `approval.resolved` when it leaves the
   * pending set, whichever way it settled (a host decision, a cancellation,
   * a rejected dispatch, session disposal).
   */
  private enqueue<K extends SettledInteractionKind>(
    kind: K,
    streamId: StreamTabId | null | undefined,
    dispatch: (
      interactions: HostInteractions,
    ) => Promise<HostInteractionResultByKind[K]> | undefined,
    permission: PermissionPayloadFor<K>,
    prepareRetry?: HostRetryInteractionOptions['prepareRetry'],
  ): Promise<HostInteractionResultByKind[K]> {
    type TResult = HostInteractionResultByKind[K];
    if (this.disposed) {
      return Promise.resolve(cancellationResultFor(kind));
    }

    return new Promise<TResult>((resolve, reject) => {
      const fact = this.publishRequested(streamId ?? undefined, permission);
      const pending: PendingSessionInteraction = {
        kind,
        streamId: streamId ?? undefined,
        ...(fact ? { fact } : {}),
        dispatch,
        cancellationResult: (cause) => cancellationResultFor(kind, cause),
        settle: (result) => resolve(result as TResult),
        reject,
        ...(prepareRetry ? { prepareRetry } : {}),
        cancellationRequested: false,
      };
      this.pending.add(pending);
      this.dispatch(pending);
    });
  }

  /** A request naming a stream is a run fact; a streamless one (an unscoped
   *  question) has no aggregate to publish on. */
  private publishRequested(
    streamId: StreamTabId | undefined,
    payload: PermissionPayload,
  ): PendingSessionInteraction['fact'] {
    if (!streamId) return undefined;
    const requestId = payload.data.requestId;
    this.session.publishRunEvent(streamId, {
      type: 'approval.requested',
      requestId,
      payload: redactedForFact(payload),
    });
    return { streamId, requestId };
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
    if (pending.fact) {
      this.session.publishRunEvent(pending.fact.streamId, {
        type: 'approval.resolved',
        requestId: pending.fact.requestId,
      });
    }
    return true;
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
