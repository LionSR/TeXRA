import {
  Cause,
  Context,
  Effect,
  Option,
  Predicate,
  Queue,
  type Scope,
  SubscriptionRef,
} from 'effect';
import {
  agentErrorPresentation,
  classifyAgentError,
  primaryAgentError,
} from '@common/errors/agentErrorClassification';
import { LaunchRefused } from '@common/errors/agentErrors';
import { withLogChannel } from '@logger/effectLog';
import { aggregateTarget, type SessionEvent } from '@shared/schemas';
import { Rejected } from '@shared/session/runtimeRequest';
import { SessionViewAccess } from '@shared/session/runHistory';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  HostPresentationFailed,
  type AgentRuntimeEmitOptions,
  type HostPresentation,
  type RuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
} from './runtimePresentationEvents';

const CHANNEL = 'Interactions';

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
  dispose?(): void;
}

/** A host that presents: one with `emit`. A host without it (a headless
 *  process, a service session before a window attaches) presents nothing,
 *  and a notice raised on it waits for the next host that does. */
type Presenter = HostInteractions & Required<Pick<HostInteractions, 'emit'>>;

const isPresenter = (host: HostInteractions | undefined): host is Presenter =>
  host?.emit !== undefined;

/** A queued or live presentation, bound to the host it presents on. */
type PresentationProgram = (
  interactions: Presenter,
) => Effect.Effect<void, HostPresentationFailed>;

/**
 * Ask a host to present one notice, fire-and-forget: the program the host
 * answers with (a dialog settles on dismissal) runs on a detached fiber, so
 * no caller blocks on it and its failure is reported, while a host that
 * throws synchronously reaches the caller as {@link HostPresentationFailed}.
 */
function presentOn<K extends RuntimePresentationEvent>(
  interactions: Presenter,
  event: K,
  payload: RuntimePresentationEventPayloads[K],
): Effect.Effect<void, HostPresentationFailed> {
  return Effect.suspend(() => {
    const presented = interactions.emit(event, payload);
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

/** What shows a notice: a session's {@link Interactions}, or a window's own
 *  host ({@link presenterOn}). */
export interface Notices {
  emit<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
    options?: AgentRuntimeEmitOptions,
  ): Effect.Effect<void>;
}

/** The program that shows one notice on whichever host presents it, live or
 *  replayed. A host that throws on a notice carrying a fallback shows the
 *  generic error toast on the same host instead. */
const noticeOf =
  <K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
    options: AgentRuntimeEmitOptions = {},
  ): PresentationProgram =>
  (host) =>
    presentOn(host, event, payload).pipe(
      Effect.catch((failure) =>
        options.fallbackMessage === undefined
          ? Effect.fail(failure)
          : Effect.logWarning(
              'Presentation emit failed; showing the generic error',
            ).pipe(
              Effect.annotateLogs({ data: failure.cause }),
              withLogChannel(CHANNEL),
              Effect.andThen(
                presentOn(host, 'requestShowError', {
                  message: options.fallbackMessage,
                }),
              ),
            ),
      ),
    );

/** Run a notice on `host`, logging a failure under `message`. */
const presentLogged = (
  notice: PresentationProgram,
  host: Presenter,
  message: string,
): Effect.Effect<void> =>
  notice(host).pipe(
    Effect.catch((failure) =>
      Effect.logWarning(message).pipe(
        Effect.annotateLogs({ data: failure.cause }),
        withLogChannel(CHANNEL),
      ),
    ),
  );

/** Notices shown on one host that is not a session's: a window presenting
 *  its own failures before a run opens. */
export function presenterOn(host: HostInteractions): Notices {
  return {
    emit: (event, payload, options) =>
      isPresenter(host)
        ? presentLogged(
            noticeOf(event, payload, options),
            host,
            'Live presentation emit failed',
          )
        : Effect.logWarning('A notice has no host to present it').pipe(
            Effect.annotateLogs({ data: { event } }),
            withLogChannel(CHANNEL),
          ),
  };
}

/**
 * A session's presentation host. One host at a time attaches
 * ({@link attachInteractions}) and the host the session was opened with
 * answers while none is. Notices raised while neither presents (none, or
 * none with `emit`) wait in `notices` for the next host that does.
 */
interface SessionInteractions extends Notices {
  /** The attached host, while one is. */
  readonly host: SubscriptionRef.SubscriptionRef<
    Option.Option<HostInteractions>
  >;
  readonly notices: Queue.Queue<PresentationProgram>;
  readonly approvalPromptsUnavailable: boolean;
}

/** The session's presentation host ({@link SessionInteractions}): the
 *  one its runs, requests and host commands present through. */
export class Interactions extends Context.Service<
  Interactions,
  SessionInteractions
>()('@texra-ai/harness/session/Interactions') {
  /**
   * The interactions of a session opened with `opened`, for the session's
   * scope. Its close disposes the attached host, then the opened one, each
   * as its own finalizer, so both are disposed even when the first fails.
   */
  static readonly make = Effect.fnUntraced(function* (
    opened: HostInteractions | undefined,
  ): Effect.fn.Return<SessionInteractions, never, Scope.Scope> {
    const host = yield* SubscriptionRef.make(Option.none<HostInteractions>());
    const notices = yield* Queue.sliding<PresentationProgram>(
      MAX_PENDING_PRESENTATION_REPLAYS,
    );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const attached = yield* SubscriptionRef.getAndSet(host, Option.none());
        yield* Queue.shutdown(notices);
        yield* Effect.scoped(
          Effect.forEach(
            [opened, Option.getOrUndefined(attached)],
            (each) =>
              Effect.addFinalizer(() => Effect.sync(() => each?.dispose?.())),
            { discard: true },
          ),
        );
      }),
    );
    const attachedNow = () =>
      Option.getOrUndefined(SubscriptionRef.getUnsafe(host));
    return {
      host,
      notices,
      get approvalPromptsUnavailable() {
        return (attachedNow() ?? opened)?.approvalPromptsUnavailable === true;
      },
      emit: (event, payload, options) =>
        Effect.suspend(() => {
          const notice = noticeOf(event, payload, options);
          const live = [attachedNow(), opened].find(isPresenter);
          if (live)
            return presentLogged(notice, live, 'Live presentation emit failed');
          if (notices.state._tag === 'Done') return Effect.void;
          const dropsOldest = Queue.isFullUnsafe(notices);
          Queue.offerUnsafe(notices, notice);
          return dropsOldest
            ? Effect.logWarning(
                `Dropped the oldest queued presentation notice: more than ${MAX_PENDING_PRESENTATION_REPLAYS} ` +
                  'notices are waiting for an interaction host to attach.',
              ).pipe(withLogChannel(CHANNEL))
            : Effect.void;
        }),
    };
  });
}

/**
 * Attach `attached` as the session's host for the caller's scope, once the
 * notices queued while no host presented are replayed to it. A session has
 * one host at a time: attaching a second while one is attached is a defect.
 * A closed session disposes the host at once; one detached by its scope is
 * disposed then.
 */
export const attachInteractions = (
  interactions: SessionInteractions,
  attached: HostInteractions,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      if (interactions.notices.state._tag === 'Done') {
        attached.dispose?.();
        return;
      }
      const took = yield* SubscriptionRef.modify(interactions.host, (current) =>
        Option.isSome(current)
          ? [false, current]
          : [true, Option.some(attached)],
      );
      if (!took)
        return yield* Effect.die(
          new Error(
            'A host is already attached to this session; a session has one host at a time.',
          ),
        );
      if (!isPresenter(attached)) return;
      for (const notice of yield* Queue.clear(interactions.notices))
        yield* presentLogged(
          notice,
          attached,
          'Failed to replay a session presentation notice',
        );
    }),
    () =>
      SubscriptionRef.modify(interactions.host, (current) =>
        Option.isSome(current) && current.value === attached
          ? [true, Option.none()]
          : [false, current],
      ).pipe(
        Effect.flatMap((held) =>
          held ? Effect.sync(() => attached.dispose?.()) : Effect.void,
        ),
      ),
  ).pipe(Effect.asVoid);

/**
 * Present a classified failure on a host: its instruction (a missing API key)
 * or its error toast. Replayed to a surface that attaches later, so no
 * guidance is lost for want of an attached host.
 */
function presentAgentFailure(
  interactions: Notices,
  error: Parameters<typeof agentErrorPresentation>[0],
): Effect.Effect<void> {
  const toast = agentErrorPresentation(error);
  return toast.type === 'instruction'
    ? interactions.emit('requestShowInstruction', toast.payload)
    : interactions.emit('requestShowError', toast.payload);
}

/**
 * The session's one terminal-result presenter, run over each folded row:
 * a `run.end` presents a root run's failure to the attached host, or
 * replays it to the next one. A child's (its attached parent is the view's,
 * which has the run's `run.start` once it ended) is its parent's to report;
 * any other row presents nothing.
 */
export const presentTerminalResult = Effect.fn('presentTerminalResult')(
  function* (
    row: SessionEvent,
  ): Effect.fn.Return<void, never, SessionViewAccess | Interactions> {
    const target = aggregateTarget(row.aggregateId);
    if (target.kind !== 'run' || row.type !== 'run.end' || !row.error) return;
    if ((yield* SessionViewAccess).run(target.id)?.parentId != null) return;
    yield* presentAgentFailure(yield* Interactions, row.error);
  },
);

/** The failure a run's raw error stands for: a `Session` start's
 *  `RunFailure` by the failure it carries, an aggregate by its first. */
const primaryFailure = (error: unknown): unknown =>
  primaryAgentError(
    Predicate.isTagged(error, 'RunFailure') && 'cause' in error
      ? error.cause
      : error,
  );

/**
 * Present a failed run from its raw error, replayed to a surface that
 * attaches later: a refused launch's notice (`LaunchRefused.notice`), or
 * else the primary failure as `prefix` plus its text (a `Rejected`
 * request's reason). With no prefix, a model failure is shown as its run
 * would record it, its classification beside, which a host may word in its
 * place; a prefixed text says more than the failure, so it is shown as
 * written. A host that throws on the notice shows that text as an error
 * instead. It presents whatever it is given, so each failure has one
 * presenter: a launch that failed before its run opened is its caller's,
 * and a run's end is the session's ({@link presentTerminalResult}).
 */
export function presentRunFailure(
  interactions: Notices,
  error: unknown,
  prefix = '',
): Effect.Effect<void> {
  const primary = primaryFailure(error);
  const reason =
    primary instanceof Rejected ? primary.reason : toErrorMessage(primary);
  const text = `${prefix}${reason}`;
  const notice = primary instanceof LaunchRefused ? primary.notice : undefined;
  if (notice !== undefined)
    return interactions.emit(notice.event, notice.payload, {
      fallbackMessage: text,
    });
  const classified = prefix === '' ? classifyAgentError(primary) : undefined;
  return presentAgentFailure(
    interactions,
    classified?.kind === 'model'
      ? classified
      : { kind: 'unexpected', message: text },
  );
}
