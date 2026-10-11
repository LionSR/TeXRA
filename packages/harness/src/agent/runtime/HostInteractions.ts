import { Cause, Effect } from 'effect';
import { withLogChannel } from '@logger/effectLog';
import type { LanguageModelPort } from '@platform/languageModel';
import type { ApprovalPolicyDenial } from '@shared/approvalPolicy';
import type { RunId } from '@shared/schemas';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { HostPresentationFailed } from './runtimePresentationEvents';
import type {
  AgentRuntimeEmitOptions,
  HostPresentation,
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from './runtimePresentationEvents';

const CHANNEL = 'SessionHostInteractions';

/**
 * Ceiling on presentation notices queued while no host is attached. A session
 * that never gets one (headless embedders, a window that never opens) would
 * otherwise accumulate every replayable notice for its whole lifetime. The
 * newest notices are the ones worth showing, so the oldest is dropped, and the
 * drop is logged, because a silently discarded notice is a defect.
 */
const MAX_PENDING_PRESENTATION_REPLAYS = 256;

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
   * host may answer with the program that puts the event on screen; nothing
   * waits on it, and its failure is reported rather than dropped (see
   * `presentOn`).
   */
  emit?<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
  ): HostPresentation;
  /**
   * This host has no channel that can answer an approval prompt (a headless
   * run, an embedder with no surface): a fact about the host alone. The
   * session applies its approval policy to it, both when it decides a request
   * and when it withholds approval-gated tools from a run.
   */
  readonly approvalPromptsUnavailable?: boolean;
  /**
   * The session's approval policy closed a gate on `runId` (a command, edit,
   * plan, delegation, retry or question) or withheld tools from it. Told
   * after the fact, so a host can say why nothing was asked; it answers
   * nothing.
   */
  approvalDenied?(denial: ApprovalPolicyDenial, runId: RunId): void;
  /** The host editor's language models, served to the session's runs. */
  readonly languageModel?: LanguageModelPort;
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
   * never committed. Every host that stages implements both. An `Effect`:
   * the cleanup (a diff view to close, temp files to
   * delete) is a program the session composes into its own, so it waits for
   * it without a fiber of its own. Built when the preview is staged, run
   * only if that one case arrives.
   */
  releaseToolEdit?(requestId: string): Effect.Effect<void>;
  /**
   * Approve a request {@link presentToolEdit} staged, with the content the
   * user edited in the host's view. `false` when nothing is staged, which
   * the caller then approves from the payload; `true` when the host took
   * the decision (a failed read of the edit included, left pending).
   */
  approveToolEdit?(requestId: string): Effect.Effect<boolean>;
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
 * Ask a host to present one notice. Presentation is fire-and-forget, so this
 * never waits on the program the host answers with (a desktop dialog settles
 * when the person dismisses it, and the run, the fold-gated result listeners
 * and the replay loop all raise notices from fibers that must not block on
 * that). It runs on a detached fiber instead, so its failure is reported
 * rather than dropped, while a host that throws synchronously reaches the
 * caller as {@link HostPresentationFailed} rather than as a defect.
 */
function presentOn<K extends RuntimePresentationEvent>(
  interactions: HostInteractions,
  event: K,
  payload: RuntimePresentationEventPayloads[K],
): Effect.Effect<void, HostPresentationFailed> {
  return Effect.suspend(() => {
    const presented = interactions.emit?.(event, payload);
    if (presented === undefined) return Effect.void;
    return Effect.forkDetach(
      presented.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning('A host presentation notice failed').pipe(
            Effect.annotateLogs({
              data: { event, cause: Cause.squash(cause) },
            }),
            withLogChannel(CHANNEL),
          ),
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
            : Effect.logWarning(
                'Presentation emit failed; showing the generic error',
              ).pipe(
                Effect.annotateLogs({ data: failure.cause }),
                withLogChannel(CHANNEL),
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
            Effect.logWarning('Live presentation emit failed').pipe(
              Effect.annotateLogs({ data: failure.cause }),
              withLogChannel(CHANNEL),
            ),
          ),
        );
      }
      // The replay loop warn-logs a replay that fails.
      return options.replayWhenAttached && !this.disposed
        ? this.queuePresentationReplay(present)
        : Effect.void;
    });
  }

  get approvalPromptsUnavailable(): boolean {
    return (
      this.activeAttachment?.interactions.approvalPromptsUnavailable === true
    );
  }

  approvalDenied(denial: ApprovalPolicyDenial, runId: RunId): void {
    this.activeAttachment?.interactions.approvalDenied?.(denial, runId);
  }

  get languageModel(): LanguageModelPort | undefined {
    return this.activeAttachment?.interactions.languageModel;
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
  ): Effect.Effect<Effect.Effect<void> | undefined> {
    return Effect.suspend(() => {
      const { requestId } = request.permission;
      const active = this.activeAttachment;
      if (!active?.interactions.presentToolEdit) {
        return Effect.logInfo(
          `No attached host stages tool-edit previews: request ${requestId} is answerable from its payload alone.`,
        ).pipe(withLogChannel(CHANNEL), Effect.as(undefined));
      }
      active.interactions.presentToolEdit(request);
      return Effect.succeed(active.interactions.releaseToolEdit?.(requestId));
    });
  }

  /** Approve a staged tool edit with the content its host view holds. */
  approveToolEdit(requestId: string): Effect.Effect<boolean> {
    return (
      this.activeAttachment?.interactions.approveToolEdit?.(requestId) ??
      Effect.succeed(false)
    );
  }

  /**
   * Dispose every attachment, newest first. Each host's dispose is a scope
   * finalizer, so every host is disposed even when an earlier one fails, and
   * every failure is its own reason in the defect the close raises, which the
   * session's teardown collects beside its other owners'.
   */
  dispose(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.disposed) return Effect.void;
      this.disposed = true;
      const pending = this.attachments.filter((attachment) => {
        if (attachment.disposed) return false;
        attachment.disposed = true;
        return true;
      });
      this.attachments.length = 0;
      this.pendingPresentationReplays.length = 0;
      return Effect.scoped(
        Effect.forEach(
          pending,
          (attachment) =>
            Effect.addFinalizer(() =>
              Effect.sync(() => attachment.interactions.dispose?.()),
            ),
          { discard: true },
        ),
      );
    });
  }

  private get activeAttachment(): HostInteractionAttachment | undefined {
    return this.attachments.at(-1);
  }

  private queuePresentationReplay(
    replay: PresentationProgram,
  ): Effect.Effect<void> {
    const dropsOldest =
      this.pendingPresentationReplays.length >=
      MAX_PENDING_PRESENTATION_REPLAYS;
    if (dropsOldest) this.pendingPresentationReplays.shift();
    this.pendingPresentationReplays.push(replay);
    return dropsOldest
      ? Effect.logWarning(
          `Dropped the oldest queued presentation notice: more than ${MAX_PENDING_PRESENTATION_REPLAYS} ` +
            'notices are waiting for an interaction host to attach.',
        ).pipe(withLogChannel(CHANNEL))
      : Effect.void;
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
            Effect.logWarning(
              'Failed to replay a session presentation notice',
            ).pipe(
              Effect.annotateLogs({ data: failure.cause }),
              withLogChannel(CHANNEL),
            ),
          ),
        );
      }
    });
  }
}
