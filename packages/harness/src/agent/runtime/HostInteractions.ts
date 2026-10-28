import { Cause, Effect } from 'effect';
import { withLogChannel } from '@logger/effectLog';
import type { ApprovalPolicyDenial } from '@shared/approvalPolicy';
import type { RunId } from '@shared/schemas';
import { HostPresentationFailed } from './runtimePresentationEvents';
import type {
  AgentRuntimeEmitOptions,
  HostPresentation,
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from './runtimePresentationEvents';

const CHANNEL = 'SessionHostInteractions';

/**
 * Ceiling on presentation notices queued while no host is attached (a
 * headless embedder, a window that never opens): the oldest is dropped, and
 * logged, since the newest are worth showing and a silent drop is a defect.
 */
const MAX_PENDING_PRESENTATION_REPLAYS = 256;

/**
 * The host's presentation surface for a session: what a host
 * can show or do on the runtime's behalf. It answers nothing. Every request a
 * run makes of a person is a `request.opened` row the fold lists and a
 * `request.decide` command a surface sends, so
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
  dispose?(): void;
}

/** A queued or live presentation, bound to the host it presents on. */
type PresentationProgram = (
  interactions: HostInteractions,
) => Effect.Effect<void, HostPresentationFailed>;

/**
 * Ask a host to present one notice, fire-and-forget: the program the host
 * answers with (a dialog settles on dismissal) runs on a detached fiber, so
 * no caller blocks on it and its failure is reported, while a host that
 * throws synchronously reaches the caller as {@link HostPresentationFailed}.
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
 * object once, while one host at a time attaches and detaches; the host the
 * session was opened with answers while none is, and notices raised while
 * none is are replayed to the next one.
 */
export class SessionHostInteractions implements HostInteractions {
  /** The attached host, while one is. */
  private attached: HostInteractions | undefined;
  private readonly opened: HostInteractions | undefined;
  private readonly pendingPresentationReplays: PresentationProgram[] = [];
  private disposed = false;

  /** `opened`: the host the session was opened with, which answers while
   *  no host is attached. */
  constructor(opened?: HostInteractions) {
    this.opened = opened;
  }

  /**
   * Attach the session's host. The returned Effect yields the detach
   * disposer once the notices queued while no host was attached have been
   * replayed to it, so an attach and its replay are one step rather than the
   * attach and a microtask that followed it. A session has one host at a
   * time: attaching a second while one is attached is a defect.
   */
  use(interactions: HostInteractions): Effect.Effect<() => void> {
    return Effect.suspend(() => {
      if (this.disposed) {
        interactions.dispose?.();
        return Effect.succeed(() => {});
      }
      if (this.attached !== undefined)
        return Effect.die(
          new Error(
            'A host is already attached to this session; a session has one host at a time.',
          ),
        );
      this.attached = interactions;
      let detached = false;
      const detach = (): void => {
        if (detached) return;
        detached = true;
        if (this.attached === interactions) this.attached = undefined;
        interactions.dispose?.();
      };
      return this.replayPendingPresentations(interactions).pipe(
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
      const active = this.attached ?? this.opened;
      if (active) {
        return present(active).pipe(
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
    return (this.attached ?? this.opened)?.approvalPromptsUnavailable === true;
  }

  approvalDenied(denial: ApprovalPolicyDenial, runId: RunId): void {
    (this.attached ?? this.opened)?.approvalDenied?.(denial, runId);
  }

  /**
   * Dispose the attached host, then the one the session was opened with.
   * Each host's dispose is a scope finalizer, so both are disposed even when
   * the first fails, and every failure is its own reason in the defect the
   * close raises, which the session's teardown collects beside its other
   * owners'.
   */
  dispose(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.disposed) return Effect.void;
      this.disposed = true;
      const hosts = [this.opened, this.attached];
      this.attached = undefined;
      this.pendingPresentationReplays.length = 0;
      return Effect.scoped(
        Effect.forEach(
          hosts,
          (host) =>
            Effect.addFinalizer(() => Effect.sync(() => host?.dispose?.())),
          { discard: true },
        ),
      );
    });
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
    interactions: HostInteractions,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      while (
        this.attached === interactions &&
        this.pendingPresentationReplays.length > 0
      ) {
        const replay = this.pendingPresentationReplays.shift();
        if (!replay) return;
        yield* replay(interactions).pipe(
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
