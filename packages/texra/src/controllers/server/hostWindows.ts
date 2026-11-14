/**
 * The windows attached to this process, and the one presentation surface it
 * gives each session they serve: a run that asks for a host capability (a
 * file's diagnostics, an inline criticism, a PDF to open, a notice) is
 * answered by a window of that session's project. The service's windows
 * attach over its socket; a window of a session this process opened attaches
 * in-process, through `localLink`.
 *
 * A call goes only to a window of the session's project: among those that
 * offer the capability, the one focused last. A call that waits for its
 * answer fails, typed, when that window detaches or does not answer in
 * time; nothing waits forever. A session holds the surface while a window of
 * it is attached: with none, a capability is absent, as it is in a headless
 * process, a notice waits for the next window when it asks to, and the
 * process says so once each time the project's last window goes. Nothing is
 * kept beyond the attachments themselves, and a call's answer reaches the
 * run's history only through the tool result that used it.
 */
import { randomUUID } from 'node:crypto';
import {
  isPathWithin,
  type PresentationEventHandlers,
  type RuntimePresentationEventPayloads,
} from '@texra-ai/harness/host';

import {
  Clock,
  Context,
  Deferred,
  Effect,
  Equal,
  Layer,
  Queue,
  RcMap,
  Ref,
  Result,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';

import {
  DiagnosticsReadFailed,
  PdfOpenFailed,
  type EditorCapabilities,
  type EditorHostShape,
} from '@texra/tools/editorHost';

import {
  ANSWERED,
  type HostAnswer,
  type HostCall,
  type HostCapability,
  type HostAttachFrame,
  type Notice,
} from './hostCalls';
import { followed, type ServiceLink } from './client';
import type { WindowClient } from './windowHost';
import type { Session, SessionHost } from '@texra-ai/harness';

/** Each runtime notice as the window call that carries it. */
const NOTICE_OF: PresentationEventHandlers<
  RuntimePresentationEventPayloads,
  Notice
> = {
  openFile: (payload) => ({ event: 'openFile', payload }),
  requestShowInstruction: (payload) => ({
    event: 'requestShowInstruction',
    payload,
  }),
  agentNotFound: (payload) => ({ event: 'agentNotFound', payload }),
  requestShowError: (payload) => ({ event: 'requestShowError', payload }),
};

/** Why a call a run waited on got no answer from a window. */
class WindowCallFailed extends Schema.TaggedError<WindowCallFailed>()(
  'WindowCallFailed',
  {
    /** `detached`: the window went before it answered; `no-answer`: it did
     *  not answer in time; `failed`: it answered with its own failure. */
    reason: Schema.Literals(['detached', 'no-answer', 'failed']),
    message: Schema.String,
  },
) {}

type Answered = typeof ANSWERED;

interface Window {
  readonly id: string;
  /** The session key of the window's project: its storage root. */
  readonly key: string;
  /** The project folder, as the notices name it. */
  readonly project: string;
  readonly capabilities: ReadonlySet<HostCapability>;
  focusedAt: number;
  readonly frames: Queue.Queue<HostAttachFrame>;
  /** The calls it has not answered yet, by call id. */
  readonly pending: Map<string, Deferred.Deferred<unknown, WindowCallFailed>>;
}

/** The project folder a session holds, or its store for a session with
 *  no folder. */
const projectOf = (session: Session): string =>
  session.roots.workspace ?? session.roots.storage;

const make = Effect.fn('make')(function* (editors: EditorHostShape) {
  const windows = new Set<Window>();
  /** Every unanswered call's window, by call id. */
  const calls = new Map<string, Window>();

  /** The window a call of `key`'s project goes to. */
  const target = (key: string, capability: HostCapability) => {
    let best: Window | undefined;
    for (const window of windows)
      if (
        window.key === key &&
        window.capabilities.has(capability) &&
        (best === undefined || window.focusedAt > best.focusedAt)
      )
        best = window;
    return best;
  };
  const offers = (key: string, capability: HostCapability) =>
    target(key, capability) !== undefined;

  /** Send a call nothing waits on: the window carries it out and says
   *  itself when it could not. */
  const tell = (window: Window, call: HostCall) =>
    Queue.offer(window.frames, {
      kind: 'call',
      id: randomUUID(),
      call,
    }).pipe(Effect.asVoid);

  /** Send a call to the window `key`'s project routes it to and wait for
   *  its answer, decoded as its kind answers. */
  const ask = Effect.fn('ask')(function* <K extends keyof Answered>(
    key: string,
    call: HostCall & { readonly kind: K },
  ): Effect.fn.Return<Answered[K]['result']['Type'], WindowCallFailed> {
    const { result, within }: Answered[K] = ANSWERED[call.kind];
    const answered = Deferred.makeUnsafe<unknown, WindowCallFailed>();
    const value = yield* Effect.acquireUseRelease(
      Effect.suspend(() => {
        // Target selection and registration are one synchronous step. The
        // acquisition installs cleanup before sending can be interrupted.
        const window = target(key, call.kind);
        if (window === undefined)
          return Effect.fail(
            new WindowCallFailed({
              reason: 'detached',
              message: 'No TeXRA window of this project is attached.',
            }),
          );
        const id = randomUUID();
        window.pending.set(id, answered);
        calls.set(id, window);
        return Effect.succeed({ window, id });
      }),
      ({ window, id }) =>
        Queue.offer(window.frames, {
          kind: 'call',
          id,
          call,
        }).pipe(
          Effect.andThen(
            Deferred.await(answered).pipe(
              Effect.timeoutOrElse({
                duration: within,
                orElse: () =>
                  Effect.fail(
                    new WindowCallFailed({
                      reason: 'no-answer',
                      message: `The TeXRA window did not answer within ${within}.`,
                    }),
                  ),
              }),
            ),
          ),
        ),
      ({ window, id }) =>
        Effect.sync(() => {
          window.pending.delete(id);
          calls.delete(id);
        }),
    );
    const parsed = Schema.decodeUnknownResult(result)(value);
    if (!Result.isSuccess(parsed))
      return yield* new WindowCallFailed({
        reason: 'failed',
        message: `The TeXRA window answered ${call.kind} with a value it does not take.`,
      });
    return parsed.success;
  });

  /** The window went: what it was asked fails, and its project hears once
   *  when no window of it is left. */
  const detach = Effect.fn('detach')(function* (window: Window) {
    windows.delete(window);
    for (const [id, pending] of window.pending) {
      calls.delete(id);
      yield* Deferred.fail(
        pending,
        new WindowCallFailed({
          reason: 'detached',
          message: 'The TeXRA window closed before it answered.',
        }),
      );
    }
    window.pending.clear();
    if (![...windows].some((other) => other.key === window.key))
      yield* Effect.logWarning(
        `No TeXRA window of ${window.project} is attached: its tasks run without diagnostics, inline criticism or PDF opening until one attaches.`,
      );
  });

  const interactionsOf = (session: Session): SessionHost => {
    const key = session.roots.storage;
    return {
      emit: (event, payload) => {
        const window = target(key, 'notices');
        const notice = NOTICE_OF[event](payload);
        return window === undefined
          ? Effect.logWarning(`Host notice ${event}`).pipe(
              Effect.annotateLogs({ data: payload }),
            )
          : tell(window, { kind: 'notices', notice });
      },
    };
  };
  /** What `session`'s project's windows offer its runs' editor tools,
   *  routed to the window focused last that offers each. */
  const editorOf = (key: string): EditorCapabilities => ({
    get readDiagnostics(): EditorCapabilities['readDiagnostics'] {
      if (!offers(key, 'readDiagnostics')) return undefined;
      return (path: string) =>
        ask(key, { kind: 'readDiagnostics', path }).pipe(
          Effect.mapError(
            (failure) =>
              new DiagnosticsReadFailed({
                reason:
                  failure.reason === 'failed' ? 'read-failed' : failure.reason,
                path,
                message: failure.message,
              }),
          ),
        );
    },
    get addCriticism(): EditorCapabilities['addCriticism'] {
      if (!offers(key, 'addCriticism')) return undefined;
      return (entry) => ask(key, { kind: 'addCriticism', entry });
    },
    get openPdf(): EditorCapabilities['openPdf'] {
      if (!offers(key, 'openPdf')) return undefined;
      return ({ location, preserveFocus }) =>
        ask(key, { kind: 'openPdf', location, preserveFocus }).pipe(
          Effect.asVoid,
          Effect.mapError(
            (failure) =>
              new PdfOpenFailed({
                path: location.absolutePath,
                message: failure.message,
              }),
          ),
        );
    },
  });
  // Each session's surface, held while a window of it is attached: the
  // session's one host, and its project's editor capabilities. A session
  // is a key by identity: a project reopened after an idle close is a new
  // session, given its own.
  const surfaces = yield* RcMap.make({
    lookup: (session: Session) =>
      Effect.andThen(
        session.attach(interactionsOf(session)),
        editors.attach(session.roots.storage, editorOf(session.roots.storage)),
      ),
  });

  /** Attach a window of `session`'s project offering `capabilities`: its
   *  id, then the calls for it, until the stream ends (the window went). */
  const attach = (
    session: Session,
    capabilities: readonly HostCapability[],
  ): Stream.Stream<HostAttachFrame> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const window: Window = {
          id: randomUUID(),
          key: session.roots.storage,
          project: projectOf(session),
          capabilities: new Set(capabilities),
          focusedAt: yield* Clock.currentTimeMillis,
          frames: yield* Queue.unbounded<HostAttachFrame>(),
          pending: new Map(),
        };
        windows.add(window);
        yield* Effect.addFinalizer(() => detach(window));
        // After the window is listed, so what the session queued while it
        // had none reaches this one.
        yield* RcMap.get(surfaces, Equal.byReferenceUnsafe(session));
        return Stream.concat(
          Stream.succeed<HostAttachFrame>({
            kind: 'attached',
            attachment: window.id,
          }),
          Stream.fromQueue(window.frames),
        );
      }),
    );
  const answer = (id: string, reply: HostAnswer) =>
    Effect.suspend(() => {
      const pending = calls.get(id)?.pending.get(id);
      if (pending !== undefined)
        return (
          reply.ok
            ? Deferred.succeed(pending, reply.value)
            : Deferred.fail(
                pending,
                new WindowCallFailed({
                  reason: 'failed',
                  message: reply.message,
                }),
              )
        ).pipe(Effect.asVoid);
      // Only an awaited call is answered: one answered after its wait ended
      // (its run gave up, or its window went) is late, not a notice.
      return Effect.logWarning(
        `A TeXRA window answered host call ${id} after its wait ended${reply.ok ? '' : `: ${reply.message}`}`,
      );
    });
  const focus = (attachment: string) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      for (const window of windows)
        if (window.id === attachment) window.focusedAt = now;
    });
  return {
    attach,
    /** Files a task wrote past the editor's own write path, as this
     *  process's announcer heard them from the task's rows: every window
     *  whose project holds one hears it, so its file tree and decorations
     *  follow the service's tasks. */
    filesWritten: (absolutePaths: readonly string[]) =>
      Effect.forEach(
        [...windows].filter(
          (window) =>
            window.capabilities.has('filesWritten') &&
            absolutePaths.some((path) => isPathWithin(window.project, path)),
        ),
        (window) => tell(window, { kind: 'filesWritten', absolutePaths }),
        { discard: true },
      ),
    /** A window was focused: its project's calls go to it first. */
    focus,
    /** A window's answer to one call. */
    answer,
    /** The link a window of `session`, a session this process opened,
     *  attaches through: always this process, never away. */
    localLink: (session: Session): Effect.Effect<ServiceLink<WindowClient>> =>
      Effect.all({
        client: Effect.map(
          SubscriptionRef.make<WindowClient | null>({
            'host.attach': ({ capabilities }) => attach(session, capabilities),
            'host.answer': (input) => answer(input.id, input.answer),
            'host.focus': ({ attachment }) => focus(attachment),
          }),
          followed,
        ),
        away: SubscriptionRef.make(''),
        refusalTold: Ref.make(false),
      }),
  };
});

/** The windows attached to this process, served on every host's process
 *  runtime over the editor registry its plugins read. */
export class HostWindows extends Context.Service<
  HostWindows,
  Effect.Success<ReturnType<typeof make>>
>()('@texra-ai/texra/server/HostWindows') {
  static readonly layer = (editors: EditorHostShape) =>
    Layer.effect(HostWindows, make(editors));
}
