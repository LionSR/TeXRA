import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@platform/interfaces';
import type {
  AgentProposal,
  Plan,
  ProviderErrorPartial,
  StreamTabId,
  UserQuestionAnswers,
  ExternalInquiryPermission,
  UserQuestionPermission,
} from '@shared/schemas';
import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';

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

export type ToolNotificationHandler = (
  message: string,
  actionCommand?: string,
  actionLabel?: string,
) => void;

export interface HostInteractionOptions {
  readonly timeoutMs?: number;
  /** Internal identity used to cancel one forwarded presentation request. */
  readonly cancellationScope?: object;
}

export type PlanApprovalResult =
  | { action: 'approve'; feedback?: never }
  | { action: 'approve_and_goal'; feedback?: never }
  | { action: 'reject'; feedback?: string }
  | { action: 'timeout'; feedback?: never };

export type ProposalResult =
  | {
      action: 'approve';
      model?: string;
      agent?: string;
      feedback?: never;
    }
  | {
      action: 'reject';
      feedback?: string;
      model?: never;
      agent?: never;
    }
  | {
      action: 'setup';
      model?: never;
      agent?: never;
      feedback?: never;
    }
  | {
      action: 'timeout';
      model?: never;
      agent?: never;
      feedback?: never;
    };

export type RetrySettlement =
  | { action: 'retry'; feedback?: string; reason?: never }
  | { action: 'cancel'; feedback?: never; reason?: never }
  | { action: 'timeout'; feedback?: never; reason?: never };

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

export interface HostBashApprovalResult {
  readonly accepted: boolean;
  readonly userMessage?: string;
  /**
   * Set when `accepted: false` came from the host-side interaction timeout
   * rather than an explicit user rejection — mirrors the distinct
   * `{ action: 'timeout' }` shape `PlanApprovalResult`/`ProposalResult`/
   * `RetryResult` already use (see #7327), kept as a flag here since
   * restructuring this result to a discriminated union isn't worth it for a
   * single boolean. Consumers must not report a timeout as a user rejection.
   */
  readonly timedOut?: boolean;
}

export type HostAgentProposalRequest = AgentProposal & {
  readonly proposalId: string;
  readonly streamId: StreamTabId;
};

export interface HostRetryRequest {
  readonly requestId: string;
  readonly streamId: StreamTabId;
  readonly operation: string;
  readonly model?: string;
  readonly errorMessage?: string;
  readonly errorDetails?: ProviderErrorPartial;
}

export type HostUserQuestionRequest = UserQuestionPermission;

export type HostUserQuestionResult =
  | {
      readonly submitted: true;
      readonly answers: UserQuestionAnswers;
      readonly feedback?: never;
    }
  | {
      readonly submitted: false;
      readonly feedback?: string;
      readonly answers?: never;
    };

export interface HostInteractionResultByKind {
  readonly bash: HostBashApprovalResult;
  readonly plan: PlanApprovalResult;
  readonly proposal: ProposalResult;
  readonly retry: RetryResult;
  readonly userQuestion: HostUserQuestionResult;
}

export type HostExternalInquiryRequest = ExternalInquiryPermission;

export interface HostExternalInquiryHandle {
  readonly threadId: string;
}

export type BashSettlement =
  | { readonly action: 'approve'; readonly feedback?: never }
  | { readonly action: 'reject'; readonly feedback?: string }
  | { readonly action: 'timeout'; readonly feedback?: never };

export type UserQuestionSettlement =
  | {
      readonly action: 'submit';
      readonly answers: UserQuestionAnswers;
      readonly feedback?: never;
    }
  | {
      readonly action: 'reject' | 'skip';
      readonly feedback?: string;
      readonly answers?: never;
    };

export type PendingInteractionKind =
  | 'toolEdit'
  | 'bash'
  | 'plan'
  | 'proposal'
  | 'retry'
  | 'userQuestion'
  | 'externalInquiry';

export type SettledInteractionKind = keyof HostInteractionResultByKind;

type CancellationResultFactories = {
  [K in SettledInteractionKind]: (
    feedback?: string,
  ) => HostInteractionResultByKind[K];
};

const cancellationResultFactories: CancellationResultFactories = {
  bash: (feedback) => ({
    accepted: false,
    timedOut: undefined,
    userMessage: feedback?.trim(),
  }),
  plan: (feedback) => ({ action: 'reject', feedback }),
  proposal: (feedback) => ({ action: 'reject', feedback }),
  retry: () => ({ action: 'cancel' }),
  userQuestion: (feedback) => ({ submitted: false, feedback }),
};

/** Typed cancellation result shared by every presenting host. */
export function cancellationResultFor<K extends SettledInteractionKind>(
  kind: K,
  feedback?: string,
): HostInteractionResultByKind[K] {
  return cancellationResultFactories[kind](feedback);
}

export type ApprovalBypassKind = 'bash' | 'toolEdit' | 'superYolo';

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
  /** Read diagnostics from the active host integration. */
  readonly readDiagnostics?: DiagnosticsReader;
  /** Add one manual criticism to the active host diagnostics surface. */
  readonly addCriticism?: AddCriticismSink;
  /** Surface unavailable tool groups through the active host UI. */
  readonly notifyUnavailableTools?: ToolNotificationHandler;
  requestToolEditApproval?(
    request: ToolEditApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<ToolEditApprovalResult> | undefined;
  requestBashApproval?(
    request: HostBashApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<HostBashApprovalResult> | undefined;
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
    options?: HostInteractionOptions,
  ): Promise<RetryResult> | undefined;
  askUserQuestion?(
    request: HostUserQuestionRequest,
    options?: HostInteractionOptions,
  ): Promise<HostUserQuestionResult> | undefined;
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
  private attachmentVersion = 0;
  private disposed = false;

  use(interactions: HostInteractions): () => void {
    if (this.disposed) {
      interactions.dispose?.();
      return () => {};
    }
    const attachment: HostInteractionAttachment = {
      interactions,
      disposed: false,
    };
    this.attachments.push(attachment);
    this.activateCurrentAttachment();
    return () => {
      if (attachment.disposed) return;
      const wasActive = this.activeAttachment === attachment;
      attachment.disposed = true;
      const index = this.attachments.indexOf(attachment);
      if (index !== -1) this.attachments.splice(index, 1);
      if (wasActive) this.activateCurrentAttachment();
      interactions.dispose?.();
    };
  }

  get readDiagnostics(): DiagnosticsReader | undefined {
    return this.activeAttachment?.interactions.readDiagnostics;
  }

  get addCriticism(): AddCriticismSink | undefined {
    return this.activeAttachment?.interactions.addCriticism;
  }

  get notifyUnavailableTools(): ToolNotificationHandler | undefined {
    return this.activeAttachment?.interactions.notifyUnavailableTools;
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
      (cause) => ({ accepted: false, userMessage: cause }),
    );
  }

  requestBashApproval(
    request: HostBashApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<HostBashApprovalResult> {
    return this.enqueue<HostBashApprovalResult>(
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
      'plan',
      request.streamId,
      (interactions) => interactions.requestPlanApproval?.(request, options),
      (cause) => cancellationResultFor('plan', cause),
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
    options?: HostInteractionOptions,
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
  ): Promise<HostUserQuestionResult> {
    return this.enqueue<HostUserQuestionResult>(
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
        if (!this.pending.delete(pending)) continue;
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
    let firstError: unknown;
    try {
      this.cancel({ cause: 'Session disposed.' });
    } catch (error) {
      firstError = error;
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
    if (firstError !== undefined) throw firstError;
  }

  /**
   * Return a presentation-only adapter for another session owner. Requests
   * pass directly to this slot's current concrete host, so forwarding does not
   * create a second session-owned pending record. Disposal is deliberately
   * absent: detaching a forwarder must not dispose the target host adapter.
   */
  createForwarder(): HostInteractions {
    return createHostInteractionsForwarder(
      () => this.activeAttachment?.interactions,
    );
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
      this.dispatch(pending);
    });
  }

  private activateCurrentAttachment(): void {
    this.attachmentVersion += 1;
    if (!this.activeAttachment) return;
    for (const pending of this.pending) {
      if (!pending.cancellationRequested) this.dispatch(pending);
    }
  }

  private dispatch(pending: PendingSessionInteraction): void {
    const attachment = this.activeAttachment;
    if (!attachment) return;
    const version = this.attachmentVersion;
    let result: Promise<unknown> | undefined;
    try {
      result = pending.dispatch(attachment.interactions);
    } catch (error) {
      this.rejectCurrentDispatch(pending, attachment, version, error);
      return;
    }
    if (!result) {
      this.pending.delete(pending);
      pending.settle(pending.cancellationResult());
      return;
    }
    void result.then(
      (value) => {
        if (!this.isCurrentDispatch(pending, attachment, version)) return;
        this.pending.delete(pending);
        pending.settle(value);
      },
      (error: unknown) => {
        this.rejectCurrentDispatch(pending, attachment, version, error);
      },
    );
  }

  private rejectCurrentDispatch(
    pending: PendingSessionInteraction,
    attachment: HostInteractionAttachment,
    version: number,
    error: unknown,
  ): void {
    if (!this.isCurrentDispatch(pending, attachment, version)) return;
    this.pending.delete(pending);
    pending.reject(error);
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

/**
 * Build a non-owning adapter for forwarding one session's requests to another.
 * Disposal is intentionally not forwarded: detaching the adapter must not
 * dispose the target session's interaction owner.
 */
function createHostInteractionsForwarder(
  target: () => HostInteractions | undefined,
): HostInteractions {
  const pending = new Set<{
    readonly kind: PendingInteractionKind;
    readonly streamId?: StreamTabId;
    readonly cancellationScope: object;
  }>();

  const forward = <T>(
    kind: PendingInteractionKind,
    streamId: StreamTabId | null | undefined,
    options: HostInteractionOptions | undefined,
    invoke: (
      interactions: HostInteractions,
      options: HostInteractionOptions,
    ) => Promise<T> | undefined,
  ): Promise<T> | undefined => {
    const interactions = target();
    if (!interactions) return undefined;
    const cancellationScope = options?.cancellationScope ?? {};
    const record = {
      kind,
      streamId: streamId ?? undefined,
      cancellationScope,
    };
    pending.add(record);
    let result: Promise<T> | undefined;
    try {
      result = invoke(interactions, { ...options, cancellationScope });
    } catch (error) {
      pending.delete(record);
      throw error;
    }
    if (!result) {
      pending.delete(record);
      return undefined;
    }
    return result.finally(() => pending.delete(record));
  };

  return {
    get readDiagnostics() {
      return target()?.readDiagnostics;
    },
    get addCriticism() {
      return target()?.addCriticism;
    },
    get notifyUnavailableTools() {
      return target()?.notifyUnavailableTools;
    },
    requestToolEditApproval: (request, options) =>
      forward(
        'toolEdit',
        request.streamId as StreamTabId | null | undefined,
        options,
        (interactions, forwardedOptions) =>
          interactions.requestToolEditApproval?.(request, forwardedOptions),
      ),
    requestBashApproval: (request, options) =>
      forward('bash', request.streamId, options, (interactions, forwarded) =>
        interactions.requestBashApproval?.(request, forwarded),
      ),
    requestPlanApproval: (request, options) =>
      forward('plan', request.streamId, options, (interactions, forwarded) =>
        interactions.requestPlanApproval?.(request, forwarded),
      ),
    requestAgentProposal: (request, options) =>
      forward(
        'proposal',
        request.streamId,
        options,
        (interactions, forwarded) =>
          interactions.requestAgentProposal?.(request, forwarded),
      ),
    requestRetry: (request, options) =>
      forward('retry', request.streamId, options, (interactions, forwarded) =>
        interactions.requestRetry?.(request, forwarded),
      ),
    askUserQuestion: (request, options) =>
      forward(
        'userQuestion',
        request.streamId,
        options,
        (interactions, forwarded) =>
          interactions.askUserQuestion?.(request, forwarded),
      ),
    openExternalInquiry: (request) => target()?.openExternalInquiry?.(request),
    setApprovalBypassState: (update) =>
      target()?.setApprovalBypassState?.(update),
    cancel: (selector = {}) => {
      const interactions = target();
      if (!interactions) return;
      const scopes = [...pending].filter((record) =>
        matchesCancelSelector(record, selector),
      );
      for (const scope of scopes) {
        interactions.cancel({
          kind: scope.kind,
          streamId: scope.streamId ?? null,
          cause: selector.cause,
          cancellationScope: scope.cancellationScope,
        });
      }
    },
  };
}
