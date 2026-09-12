import type { ReviewIssueReport } from '@agent/review/reviewIssues';
import { createLog } from '@logger/logUtils';
import type { FileLocation, RunId } from '@shared/schemas';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';
import type {
  AgentRuntimeEmitOptions,
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

export interface HostApprovalBypassStateUpdate {
  readonly runId: RunId;
  readonly kind: ApprovalBypassKind;
  readonly bypassActive: boolean;
}

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
   */
  presentToolEdit?(request: ToolEditApprovalRequest): void;
  setApprovalBypassState?(update: HostApprovalBypassStateUpdate): void;
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

  presentToolEdit(request: ToolEditApprovalRequest): void {
    const active = this.activeAttachment;
    if (!active?.interactions.presentToolEdit) {
      logger.info(
        `No attached host stages tool-edit previews: request ${request.permission.requestId} is answerable from its payload alone.`,
      );
      return;
    }
    active.interactions.presentToolEdit(request);
  }

  setApprovalBypassState(update: HostApprovalBypassStateUpdate): void {
    this.activeAttachment?.interactions.setApprovalBypassState?.(update);
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
