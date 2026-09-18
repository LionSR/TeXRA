import { Cause, Effect, Exit } from 'effect';
import type { ReviewIssueReport } from '@agent/review/reviewIssues';
import { createLog } from '@logger/logUtils';
import type { FileLocation } from '@shared/schemas';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { throwAggregated } from '@utils/core';
import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';
import { HostPresentationFailed } from './runtimePresentationEvents';
import type {
  AgentRuntimeEmitOptions,
  DiagnosticsReadFailed,
  PdfOpenFailed,
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from './runtimePresentationEvents';

const logger = createLog('SessionHostInteractions');

/**
 * Ceiling on presentation notices queued while no host is attached. A session
 * that never gets one (headless embedders, a window that never opens) would
 * otherwise accumulate every replayable notice for its whole lifetime. The
 * newest notices are the ones worth showing, so the oldest is dropped, and the
 * drop is logged, because a silently discarded notice is a defect.
 */
const MAX_PENDING_PRESENTATION_REPLAYS = 256;

/**
 * Read a file's diagnostics from the host's own language tooling. `path` is
 * absolute — the diagnostics tool resolves the model's input against its tool
 * root before calling. An `Effect`:
 * a host that could not produce them reaches the diagnostics tool as
 * {@link DiagnosticsReadFailed} instead of as `unknown`, and a tool call that
 * is interrupted while the host rebuilds stops waiting on it.
 */
type DiagnosticsReader = (
  path: string,
) => Effect.Effect<GenericDiagnostic[], DiagnosticsReadFailed>;

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

/**
 * Show a PDF in the host's viewer. An `Effect`, so a viewer that refused
 * reaches the tool as {@link PdfOpenFailed} rather than as an `unknown`
 * rejection — and the `Promise<void> | void` union the port carried while it
 * was Promise-shaped is gone with it.
 */
type OpenPdfOpener = (
  request: OpenPdfRequest,
) => Effect.Effect<void, PdfOpenFailed>;

/**
 * Collects one agent-review finding. Returns `accepted: false` with a reason
 * when no review session is collecting issues (or the report is rejected), so
 * the tool can surface that to the agent.
 */
type ReportReviewIssueSink = (report: ReviewIssueReport) => {
  readonly accepted: boolean;
  readonly reason?: string;
};

/**
 * The host's presentation surface for a session (ruling A9-3): what a host
 * can show or do on the runtime's behalf. It answers nothing. Every request a
 * run makes of a person is a `request.opened` row the fold lists and a
 * `request.decide` command a surface sends (one run model, section 3.7), so
 * there is no queue behind this port and no method returns a decision.
 */
export interface HostInteractions {
  /**
   * Present a runtime event through the active host attachment. Presentation
   * is fire-and-forget: a host that cannot render an event logs the cause. A
   * host may return a promise that settles once the event is on screen.
   */
  emit?<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
  ): unknown;
  /** Read diagnostics from the active host integration. */
  readonly readDiagnostics?: DiagnosticsReader;
  /** Add one manual criticism to the active host diagnostics surface. */
  readonly addCriticism?: AddCriticismSink;
  /** Open a PDF in the active host's viewer. */
  readonly openPdf?: OpenPdfOpener;
  /** Report one agent-review finding to the active host's review session. */
  readonly reportReviewIssue?: ReportReviewIssueSink;
  /**
   * Stage a tool edit's preview (its original and proposed content, which
   * the durable request payload does not carry) for the request the fold
   * lists under `request.permission.requestId`. The decision comes back as
   * that request's `request.decide`; a host that stages nothing leaves the
   * request answerable from its payload alone.
   *
   * The session's own {@link SessionHostInteractions.presentToolEdit} hands
   * its caller the release for what this staged; a host implements the
   * staging alone.
   */
  presentToolEdit?(request: ToolEditApprovalRequest): void;
  /**
   * Drop what {@link presentToolEdit} staged for one request, for the single
   * case no `request.decided` ever reaches: a request whose `request.opened`
   * never committed. It pairs with `presentToolEdit` — every host that
   * stages implements both, and a host that stages nothing implements
   * neither, which is why this port is optional like the rest of this
   * surface. An `Effect`, the way `openPdf` is: the cleanup a host's release
   * needs (a diff view to close, temp files to delete) is a program this
   * call builds and the session composes into its own, so the session waits
   * for the cleanup it asked for without running a fiber of its own — which
   * a VS Code-free zone has no runtime to do. Built when the preview is
   * staged, run only if that one case arrives, so the body of this call
   * stages nothing and undoes nothing on its own.
   */
  releaseToolEdit?(requestId: string): Effect.Effect<void, unknown>;
  dispose?(): void;
}

interface HostInteractionAttachment {
  readonly interactions: HostInteractions;
  disposed: boolean;
}

/** A queued or live presentation, bound to the host it presents on. */
type PresentationProgram = (
  interactions: HostInteractions,
) => Effect.Effect<void, HostPresentationFailed>;

/**
 * The one lift of what a host's `emit` answers with. Presentation is
 * fire-and-forget, so this never waits on a host that answers with a promise
 * (a desktop dialog settles when the person dismisses it, and the run, the
 * fold-gated result listeners and the replay loop all raise notices from
 * fibers that must not block on that). The promise is watched on a detached
 * fiber instead, so a rejection is reported rather than left unhandled, while
 * a host that throws synchronously reaches the caller as
 * {@link HostPresentationFailed} rather than as a defect.
 */
function presentOn<K extends RuntimePresentationEvent>(
  interactions: HostInteractions,
  event: K,
  payload: RuntimePresentationEventPayloads[K],
): Effect.Effect<void, HostPresentationFailed> {
  return Effect.suspend(() => {
    const settled: unknown = interactions.emit?.(event, payload);
    const thenable =
      typeof settled === 'object' &&
      settled !== null &&
      'then' in settled &&
      typeof settled.then === 'function'
        ? (settled as PromiseLike<unknown>)
        : undefined;
    if (!thenable) return Effect.void;
    return Effect.forkDetach(
      Effect.tryPromise({
        try: async () => await thenable,
        catch: (cause) => new HostPresentationFailed({ event, cause }),
      }).pipe(
        Effect.catch((failure) =>
          Effect.sync(() => {
            logger.warn('A host presentation notice never settled', {
              data: failure.cause,
            });
          }),
        ),
      ),
    ).pipe(Effect.asVoid);
  }).pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(new HostPresentationFailed({ event, cause: defect })),
    ),
  );
}

/**
 * Stable per-session presentation owner. The `SessionHandle` exposes this
 * object once, while hosts may attach and detach presentation adapters; the
 * newest attachment presents, and notices raised while none is attached are
 * replayed to the next one.
 */
export class SessionHostInteractions implements HostInteractions {
  private readonly attachments: HostInteractionAttachment[] = [];
  private readonly pendingPresentationReplays: PresentationProgram[] = [];
  private disposed = false;

  /**
   * Attach a presentation host. The returned Effect yields the detach
   * disposer once the notices queued while no host was attached have been
   * replayed to it, so an attach and its replay are one step rather than the
   * attach and a microtask that followed it.
   */
  use(interactions: HostInteractions): Effect.Effect<() => void> {
    return Effect.suspend(() => {
      if (this.disposed) {
        interactions.dispose?.();
        return Effect.succeed(() => {});
      }
      const attachment: HostInteractionAttachment = {
        interactions,
        disposed: false,
      };
      this.attachments.push(attachment);
      const detach = (): void => {
        if (attachment.disposed) return;
        attachment.disposed = true;
        const index = this.attachments.indexOf(attachment);
        if (index !== -1) this.attachments.splice(index, 1);
        interactions.dispose?.();
      };
      return this.replayPendingPresentations(attachment).pipe(
        Effect.as(detach),
      );
    });
  }

  emit<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
    options: AgentRuntimeEmitOptions = {},
  ): Effect.Effect<void> {
    // Live or replayed, a host that throws on a notice carrying a fallback
    // shows the generic error toast on the same host instead.
    const present: PresentationProgram = (interactions) =>
      presentOn(interactions, event, payload).pipe(
        Effect.catch((failure) =>
          options.fallbackMessage === undefined
            ? Effect.fail(failure)
            : Effect.sync(() => {
                logger.warn(
                  'Presentation emit failed; showing the generic error',
                  { data: failure.cause },
                );
              }).pipe(
                Effect.andThen(
                  presentOn(interactions, 'requestShowError', {
                    message: options.fallbackMessage,
                  }),
                ),
              ),
        ),
      );
    return Effect.suspend(() => {
      const active = this.activeAttachment;
      if (active) {
        return present(active.interactions).pipe(
          Effect.catch((failure) =>
            Effect.sync(() => {
              logger.warn('Live presentation emit failed', {
                data: failure.cause,
              });
            }),
          ),
        );
      }
      // The replay loop warn-logs a replay that fails.
      if (options.replayWhenAttached && !this.disposed) {
        this.queuePresentationReplay(present);
      }
      return Effect.void;
    });
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

  /**
   * Stage a preview on the attached host and hand back the release for it,
   * bound to the attachment that staged: the stack may have changed by the
   * time the release runs, and a release sent to whichever host is newest
   * then would be a no-op on a host that staged nothing while the one that
   * did kept its diff and temp files. `undefined` is "nothing is staged":
   * either no attached host stages previews, or the one that did releases
   * nothing. The release itself is the host's own program, run by the caller
   * that holds it — a cleanup failure is that caller's to report, so it
   * never masks the outcome of the call that staged.
   */
  presentToolEdit(
    request: ToolEditApprovalRequest,
  ): Effect.Effect<void, unknown> | undefined {
    const { requestId } = request.permission;
    const active = this.activeAttachment;
    if (!active?.interactions.presentToolEdit) {
      logger.info(
        `No attached host stages tool-edit previews: request ${requestId} is answerable from its payload alone.`,
      );
      return undefined;
    }
    active.interactions.presentToolEdit(request);
    return active.interactions.releaseToolEdit?.(requestId);
  }

  /**
   * Dispose every attachment, newest first. Every host is disposed even when
   * an earlier one fails, and every failure is reported: the Effect fails
   * with each host's own cause, so the session's teardown aggregates them
   * with the rest of its owners rather than losing all but the first.
   */
  dispose(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.disposed) return Effect.void;
      this.disposed = true;
      const pending = this.attachments.toReversed().filter((attachment) => {
        if (attachment.disposed) return false;
        attachment.disposed = true;
        return true;
      });
      this.attachments.length = 0;
      this.pendingPresentationReplays.length = 0;
      return Effect.forEach(pending, (attachment) =>
        Effect.exit(Effect.sync(() => attachment.interactions.dispose?.())),
      ).pipe(
        Effect.flatMap((exits) =>
          Effect.sync(() => {
            throwAggregated(
              exits.flatMap((exit) =>
                Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
              ),
              'Host interaction attachments failed to dispose',
            );
          }),
        ),
      );
    });
  }

  private get activeAttachment(): HostInteractionAttachment | undefined {
    return this.attachments.at(-1);
  }

  private queuePresentationReplay(replay: PresentationProgram): void {
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
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      while (
        !attachment.disposed &&
        this.activeAttachment === attachment &&
        this.pendingPresentationReplays.length > 0
      ) {
        const replay = this.pendingPresentationReplays.shift();
        if (!replay) return;
        yield* replay(attachment.interactions).pipe(
          Effect.catch((failure) =>
            Effect.sync(() => {
              logger.warn('Failed to replay a session presentation notice', {
                data: failure.cause,
              });
            }),
          ),
        );
      }
    });
  }
}
