// Background-run lifecycle for long-running provider jobs (OpenAI Responses
// `background:true`, Google Interactions `background:true`).
//
// Owns the pending-background-run bookkeeping (the id + retrieve params
// needed to resume polling after a disconnect) and the choreography around
// the shared BackgroundPoller: resuming a run left pending by a prior
// connection failure, polling a freshly-submitted run to completion, and
// recovering a run id surfaced by an unhandled mid-stream SSE event. The
// handler asks this collaborator "is anything pending, and what do I do about
// it" instead of mutating pending-run fields itself — every field here is
// private, reachable only through the narrow methods below.
//
// Provider specifics (status vocabularies, retrieve calls, error factories,
// stale-id predicates, server-side cancellation) are injected through
// {@link BackgroundRunLifecycleConfig}; this class owns only the control
// flow and the pending-id/deadline state machine.
//
// Like the handler it's attached to, an instance is single-turn: do not share
// it across concurrent invocations (see the handler's class doc).

import type { AgentTrace } from '@agent/trace';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';

import {
  BackgroundPoller,
  type BackgroundPollStats,
} from './BackgroundPoller';

/**
 * What the lifecycle should do with the pending id after a failed retrieve.
 * The original error (or the verdict's replacement) always propagates except
 * for `restart`, which only {@link BackgroundRunLifecycle.tryResume} honors by
 * returning null so the caller starts a new request.
 */
export type BackgroundRetrieveFailureVerdict =
  /** Keep the pending id (the run is likely still alive); rethrow. */
  | { action: 'retain' }
  /** Drop the pending id; rethrow the original error. */
  | { action: 'clear' }
  /** Drop the pending id; throw the given error instead of the original. */
  | { action: 'replace'; error: Error }
  /** Drop the pending id; tryResume returns null (start a new request). */
  | { action: 'restart' };

/** What tryResume should do with a resumed run that is no longer pending. */
type BackgroundResumedSettledVerdict<TResponse> =
  /** Return the response to the caller (it completed while disconnected). */
  | { action: 'complete'; response: TResponse }
  /** The run ended remotely; return null so the caller starts a new request. */
  | { action: 'restart' }
  /** Route the response through the poll driver (its terminal handling). */
  | { action: 'poll' };

/** Provider decision for a run that reached a non-serviceable terminal status. */
export interface BackgroundTerminalVerdict {
  readonly error: Error;
  /** Whether to drop the pending id before throwing (false = fail closed and
   *  keep the id so an explicit retry can resume the same run). */
  readonly clearPending: boolean;
}

/**
 * Provider-specific wiring for a {@link BackgroundRunLifecycle}. Every hook is
 * a one-liner in the owning handler/factory; the lifecycle owns the shared
 * control flow they plug into.
 */
interface BackgroundRunLifecycleConfig<
  TClient,
  TResponse,
  TRetrieveParams,
> {
  /** Supplier rather than a snapshot: the handler's logger can be replaced
   *  after construction via `setLogger()`. */
  logger: () => AgentTrace;
  /** Human-readable label for poller logs (e.g. `'OpenAI'`,
   *  `'Google Interactions'`). */
  providerLabel: string;
  /** Resource noun for poller logs (e.g. `'response'`, `'interaction'`). */
  resourceLabel: string;
  pollIntervalMs: number;
  maxDurationMs: number;
  /** Statuses still meaning "processing" (e.g. `queued` / `in_progress`). */
  isPendingStatus: (response: TResponse) => boolean;
  /** Terminal statuses the caller can service (OpenAI: `completed`; Google:
   *  `completed` OR `requires_action`, which carries tool calls). */
  isServiceableStatus: (response: TResponse) => boolean;
  extractId: (response: TResponse) => string | undefined;
  /** Human-readable status string for poller log messages. */
  extractStatus: (response: TResponse) => string;
  /** Raw provider retrieval by id; classification belongs in the verdict
   *  hooks below, not here. */
  retrieve: (
    client: TClient,
    responseId: string,
    retrieveParams: TRetrieveParams | undefined,
    signal: AbortSignal | undefined,
  ) => Promise<TResponse>;
  /** Tag an SDK error so `isUserAbort` is robust (provider-specific tagger). */
  tagSdkError: (error: unknown) => void;
  /** Classify a failed RESUME retrieve (tryResume). */
  onResumeRetrieveError: (
    error: unknown,
    responseId: string,
  ) => BackgroundRetrieveFailureVerdict;
  /** Classify a failed retrieve from inside the poll loop. */
  onPollRetrieveError: (
    error: unknown,
    responseId: string,
  ) => BackgroundRetrieveFailureVerdict;
  /** Classify a failed retrieve in {@link BackgroundRunLifecycle.retrieveAndRemember}.
   *  Optional: only consulted on that path. Defaults to `retain`. */
  onRecoveredRetrieveError?: (
    error: unknown,
    responseId: string,
  ) => BackgroundRetrieveFailureVerdict;
  /** Provider timeout error for an exhausted polling lifetime. */
  createTimeoutError: (responseId: string) => Error;
  /** Decide what a resumed, no-longer-pending run means. */
  onResumedSettled: (
    response: TResponse,
    responseId: string,
  ) => BackgroundResumedSettledVerdict<TResponse>;
  /** Decide what a non-serviceable terminal run means (log + error). */
  createTerminalVerdict: (
    response: TResponse,
    responseId: string,
    stats: BackgroundPollStats | undefined,
  ) => BackgroundTerminalVerdict;
  /** Whether a serviceable terminal clears the pending id here (Google) or is
   *  the caller's job (OpenAI's finalizeResponse clears it later). */
  clearOnServiceableTerminal: boolean;
  /** Provider fields appended to the poller's polling-finished log. */
  extraFinishData?: (response: TResponse) => Record<string, unknown>;
  /** Best-effort server-side cancel after an abort discards the pending id
   *  (Google). Fire-and-forget: never awaited, so abort propagation never
   *  blocks on it. */
  onAbortDiscard?: (client: TClient, responseId: string) => void;
  /** Best-effort server-side cancel after a timeout discards the pending id
   *  (Google). Awaited before the timeout error propagates. */
  onTimeoutDiscard?: (client: TClient, responseId: string) => void | Promise<void>;
  /** Diagnostic hook: a resume is about to retrieve (OpenAI debug log). */
  onResumeStart?: (responseId: string) => void;
  /** Diagnostic hook: the resumed run is still processing (OpenAI debug log). */
  onResumeStillPending?: (response: TResponse, responseId: string) => void;
}

export class BackgroundRunLifecycle<TClient, TResponse, TRetrieveParams> {
  private readonly backgroundPoller = new BackgroundPoller<TResponse>({
    pollIntervalMs: this.config.pollIntervalMs,
    maxDurationMs: this.config.maxDurationMs,
    isPending: (r) => this.config.isPendingStatus(r),
    logger: this.config.logger,
  });

  /**
   * The id of a background run currently being polled. Lets retry logic
   * resume polling the same run instead of creating a new request when
   * connection errors occur mid-poll.
   */
  private pendingResponseId: string | null = null;
  private pendingRetrieveParams: TRetrieveParams | undefined;
  private pendingDeadlineAtMs: number | null = null;

  constructor(
    private readonly config: BackgroundRunLifecycleConfig<
      TClient,
      TResponse,
      TRetrieveParams
    >,
  ) {}

  /** Whether the given response's status still means "processing". */
  isPending(response: TResponse): boolean {
    return this.config.isPendingStatus(response);
  }

  /** Whether a background run is currently pending resume. */
  hasPendingResume(): boolean {
    return this.pendingResponseId !== null;
  }

  /** The id of the pending background run, if any (diagnostics only). */
  getPendingId(): string | null {
    return this.pendingResponseId;
  }

  /** Clears the pending background run id. Single point of mutation. */
  clearPending(): void {
    this.pendingResponseId = null;
    this.pendingRetrieveParams = undefined;
    this.pendingDeadlineAtMs = null;
  }

  /** Clears the pending run only when it is the given id. */
  private clearPendingIfId(responseId: string): boolean {
    if (this.pendingResponseId !== responseId) return false;
    this.clearPending();
    return true;
  }

  /**
   * Abort-check a pending background run before the caller does any per-call
   * work (token counting, compaction). No-op when nothing is pending. Never
   * awaits the provider's best-effort cancel.
   */
  assertPendingNotAborted(client: TClient, signal?: AbortSignal): void {
    const pendingId = this.pendingResponseId;
    if (pendingId === null || !signal?.aborted) return;
    if (this.clearPendingIfId(pendingId)) {
      this.config.onAbortDiscard?.(client, pendingId);
    }
    signal.throwIfAborted();
  }

  private rememberPending(
    responseId: string,
    retrieveParams?: TRetrieveParams,
  ): number {
    if (
      this.pendingResponseId !== responseId ||
      this.pendingDeadlineAtMs === null
    ) {
      this.pendingDeadlineAtMs = Date.now() + this.config.maxDurationMs;
    }
    this.pendingResponseId = responseId;
    this.pendingRetrieveParams = retrieveParams;
    return this.pendingDeadlineAtMs;
  }

  /**
   * The abort/deadline checkpoint shared by every retrieve boundary. Abort
   * wins over expiry; abort discards are fire-and-forget, timeout discards
   * are awaited (both provider-optional).
   */
  private async assertCanPoll(
    client: TClient,
    responseId: string,
    deadlineAtMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      if (this.clearPendingIfId(responseId)) {
        this.config.onAbortDiscard?.(client, responseId);
      }
      signal.throwIfAborted();
    }
    if (Date.now() >= deadlineAtMs) {
      this.clearPendingIfId(responseId);
      await this.config.onTimeoutDiscard?.(client, responseId);
      throw this.config.createTimeoutError(responseId);
    }
  }

  /**
   * Shared handling for a failed retrieve: tag, abort (discard + rethrow),
   * re-check the abort/deadline boundaries, then apply the provider verdict.
   * Returns ONLY for a `restart` verdict (pending id already dropped); every
   * other verdict throws.
   */
  private async handleRetrieveFailure(
    client: TClient,
    error: unknown,
    responseId: string,
    deadlineAtMs: number,
    signal: AbortSignal | undefined,
    classify: (
      error: unknown,
      responseId: string,
    ) => BackgroundRetrieveFailureVerdict,
  ): Promise<void> {
    this.config.tagSdkError(error);
    if (isUserAbort(error)) {
      if (this.clearPendingIfId(responseId)) {
        this.config.onAbortDiscard?.(client, responseId);
      }
      throw error;
    }
    await this.assertCanPoll(client, responseId, deadlineAtMs, signal);
    const verdict = classify(error, responseId);
    if (verdict.action === 'retain') throw error;
    this.clearPendingIfId(responseId);
    if (verdict.action === 'replace') throw verdict.error;
    if (verdict.action === 'restart') return;
    throw error;
  }

  /**
   * Attempts to resume polling a pending background run.
   *
   * @returns The completed response if resume succeeded, or null if a new
   *          request is needed. Throws on abort (user cancellation).
   */
  async tryResume(client: TClient, signal?: AbortSignal): Promise<TResponse | null> {
    const pendingId = this.pendingResponseId;
    if (!pendingId) {
      return null;
    }
    const retrieveParams = this.pendingRetrieveParams;
    const deadlineAtMs = this.rememberPending(pendingId, retrieveParams);
    await this.assertCanPoll(client, pendingId, deadlineAtMs, signal);
    this.config.onResumeStart?.(pendingId);

    let pendingResponse: TResponse;
    try {
      pendingResponse = await this.config.retrieve(
        client,
        pendingId,
        retrieveParams,
        signal,
      );
    } catch (err) {
      // handleRetrieveFailure returns only for a 'restart' verdict: the run
      // is definitively gone (e.g. an expired 404), so start a new request.
      // Every other verdict throws out of it.
      await this.handleRetrieveFailure(
        client,
        err,
        pendingId,
        deadlineAtMs,
        signal,
        this.config.onResumeRetrieveError,
      );
      return null;
    }
    await this.assertCanPoll(client, pendingId, deadlineAtMs, signal);

    if (this.config.isPendingStatus(pendingResponse)) {
      // Still processing - resume polling
      this.config.onResumeStillPending?.(pendingResponse, pendingId);
      // Note: clearPending() called by the handler's finalizeResponse() in caller
      return this.pollToTerminal(
        client,
        pendingResponse,
        retrieveParams,
        deadlineAtMs,
        signal,
      );
    }

    const settled = this.config.onResumedSettled(pendingResponse, pendingId);
    if (settled.action === 'complete') {
      // Note: clearPending() called by the handler's finalizeResponse() in caller
      return settled.response;
    }
    if (settled.action === 'restart') {
      this.clearPendingIfId(pendingId);
      return null;
    }
    return this.pollToTerminal(
      client,
      pendingResponse,
      retrieveParams,
      deadlineAtMs,
      signal,
    );
  }

  /**
   * Retrieves a response by id after an unhandled mid-stream SSE event (a
   * heartbeat/keepalive frame the SDK's stream accumulator doesn't parse),
   * remembering it as pending so a connection failure during the retrieve can
   * be resumed via {@link tryResume} instead of starting a new request.
   * Unlike {@link tryResume}, failures here always rethrow to the caller's own
   * streaming catch block, which owns retry classification for that path.
   */
  async retrieveAndRemember(
    client: TClient,
    responseId: string,
    retrieveParams: TRetrieveParams | undefined,
    signal: AbortSignal | undefined,
  ): Promise<TResponse> {
    const deadlineAtMs = this.rememberPending(responseId, retrieveParams);
    await this.assertCanPoll(client, responseId, deadlineAtMs, signal);
    let response: TResponse;
    try {
      response = await this.config.retrieve(
        client,
        responseId,
        retrieveParams,
        signal,
      );
    } catch (err) {
      await this.handleRetrieveFailure(
        client,
        err,
        responseId,
        deadlineAtMs,
        signal,
        this.config.onRecoveredRetrieveError ?? (() => ({ action: 'retain' })),
      );
      // handleRetrieveFailure rethrows for every verdict on this path except
      // 'restart', which retrieveAndRemember does not honor — treat it as
      // 'clear' (pending id already dropped) and rethrow the original error.
      throw err;
    }
    await this.assertCanPoll(client, responseId, deadlineAtMs, signal);
    return response;
  }

  /**
   * Poll a (possibly just-submitted) response until it reaches a terminal
   * status, remembering the id as pending so a connection failure mid-poll
   * can be resumed via {@link tryResume} instead of starting a new request.
   */
  async waitForCompletion<T extends TResponse>(
    client: TClient,
    initialResponse: T,
    signal?: AbortSignal,
    retrieveParams?: TRetrieveParams,
  ): Promise<T> {
    const initialId = this.config.extractId(initialResponse);
    if (!initialId) {
      return initialResponse;
    }

    // Track which response is being polled so retry logic can resume via
    // tryResume instead of creating a new request.
    const deadlineAtMs = this.rememberPending(initialId, retrieveParams);
    await this.assertCanPoll(client, initialId, deadlineAtMs, signal);

    return (await this.pollToTerminal(
      client,
      initialResponse,
      retrieveParams,
      deadlineAtMs,
      signal,
    )) as T;
  }

  /**
   * Drive the shared BackgroundPoller to a terminal status and apply the
   * provider's terminal verdict. Keys the poll (and any clear/cancel) on the
   * REMEMBERED pending id rather than the retrieved response's own id, so a
   * response that comes back carrying a different id cannot redirect the
   * cancel target or strand the original pending bookkeeping.
   */
  private async pollToTerminal(
    client: TClient,
    initialResponse: TResponse,
    retrieveParams: TRetrieveParams | undefined,
    deadlineAtMs: number,
    signal?: AbortSignal,
  ): Promise<TResponse> {
    const pollId =
      this.pendingResponseId ?? this.config.extractId(initialResponse);
    if (pollId === undefined) {
      // Unreachable: tryResume only polls with a remembered pending id and
      // waitForCompletion remembers one before delegating here.
      return initialResponse;
    }

    let pollStats: BackgroundPollStats | undefined;
    let timeoutError: Error | undefined;
    let polled: TResponse;
    try {
      polled = await this.backgroundPoller.poll({
        initialResponse,
        retrieve: async (responseId, sig) => {
          try {
            return await this.config.retrieve(
              client,
              responseId,
              retrieveParams,
              sig,
            );
          } catch (err) {
            await this.handleRetrieveFailure(
              client,
              err,
              responseId,
              deadlineAtMs,
              sig,
              this.config.onPollRetrieveError,
            );
            // A 'restart' verdict is meaningless mid-poll (there is no "new
            // request" to fall through to); providers must not return it here.
            // Treat it as 'clear' and rethrow the original error.
            throw err;
          }
        },
        extractId: () => pollId,
        extractStatus: (r) => this.config.extractStatus(r),
        signal,
        deadlineAtMs,
        resourceLabel: this.config.resourceLabel,
        providerLabel: this.config.providerLabel,
        onAbort: () => {
          if (this.clearPendingIfId(pollId)) {
            this.config.onAbortDiscard?.(client, pollId);
          }
        },
        formatTimeoutError: () => {
          timeoutError = this.config.createTimeoutError(pollId);
          return timeoutError;
        },
        extraFinishData: (response) =>
          this.config.extraFinishData?.(response) ?? {},
        onFinished: (_response, stats) => {
          pollStats = stats;
        },
      });
    } catch (err) {
      // The poller rethrows the exact Error formatTimeoutError returned, so
      // identity recognizes the timeout: discard the pending id and run the
      // provider's awaited best-effort cancel before it propagates.
      if (timeoutError !== undefined && err === timeoutError) {
        this.clearPendingIfId(pollId);
        await this.config.onTimeoutDiscard?.(client, pollId);
      }
      throw err;
    }

    if (this.config.isServiceableStatus(polled)) {
      if (this.config.clearOnServiceableTerminal) {
        this.clearPendingIfId(pollId);
      }
      return polled;
    }

    // Terminal failure — the background run ended with a non-serviceable,
    // non-pending status. The provider hook owns the log line, the error, and
    // whether the pending id is dropped or retained (fail-closed).
    const verdict = this.config.createTerminalVerdict(polled, pollId, pollStats);
    if (verdict.clearPending) {
      this.clearPendingIfId(pollId);
    }
    throw verdict.error;
  }
}
