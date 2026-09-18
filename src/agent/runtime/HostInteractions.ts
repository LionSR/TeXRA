import type { ReviewIssueReport } from '@agent/review/reviewIssues';
import { createLog } from '@logger/logUtils';
import type { FileLocation } from '@shared/schemas';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';
import type { Effect } from 'effect';
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

/**
 * Stable per-session presentation owner. The `SessionHandle` exposes this
 * object once, while hosts may attach and detach presentation adapters; the
 * newest attachment presents, and notices raised while none is attached are
 * replayed to the next one.
 */
export class SessionHostInteractions implements HostInteractions {
  private readonly attachments: HostInteractionAttachment[] = [];
  private readonly pendingPresentationReplays: Array<
    (interactions: HostInteractions) => unknown
  > = [];
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
    queueMicrotask(() => this.replayPendingPresentations(attachment));
    return () => {
      if (attachment.disposed) return;
      attachment.disposed = true;
      const index = this.attachments.indexOf(attachment);
      if (index !== -1) this.attachments.splice(index, 1);
      interactions.dispose?.();
    };
  }

  emit<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
    options: AgentRuntimeEmitOptions = {},
  ): unknown {
    // Live or replayed, a host that throws on a notice carrying a fallback
    // shows the generic error toast on the same host instead.
    const present = (interactions: HostInteractions) => {
      try {
        return interactions.emit?.(event, payload);
      } catch (error) {
        if (options.fallbackMessage === undefined) throw error;
        logger.warn('Presentation emit failed; showing the generic error', {
          data: error,
        });
        return interactions.emit?.('requestShowError', {
          message: options.fallbackMessage,
        });
      }
    };
    const active = this.activeAttachment;
    if (active) {
      try {
        return present(active.interactions);
      } catch (error) {
        logger.warn('Live presentation emit failed', { data: error });
        return undefined;
      }
    }
    // The replay loop warn-logs a replay that throws or rejects.
    if (options.replayWhenAttached && !this.disposed) {
      this.queuePresentationReplay(present);
    }
    return undefined;
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    let firstError: unknown;
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
}
