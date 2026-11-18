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
  Cause,
  Clock,
  Context,
  Effect,
  Equal,
  Layer,
  Queue,
  RcMap,
  Ref,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';
import { RpcClient, type RpcClientError, type RpcMessage } from 'effect/rpc';

import {
  DiagnosticsReadFailed,
  PdfOpenFailed,
  editorRegistry,
  type EditorCapabilities,
} from '@texra/tools/editorHost';

import {
  ASKED_WITHIN,
  WindowRpcs,
  type HostCallFailed,
  type HostCapability,
  type HostAttachFrame,
  type Notice,
} from './hostCalls';
import { callOverMessages } from '@texra/shared/rpcOverMessages';
import { linkOver, type Linked, type ServiceLink } from './client';
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

/** Calls the service has sent a window that its stream has not carried
 *  yet: a run that calls past them waits until the window reads. */
const CALLS_AHEAD = 64;

/** The service's client of one window's `WindowRpcs`. */
type WindowCalls = RpcClient.FromGroup<
  typeof WindowRpcs,
  RpcClientError.RpcClientError
>;

interface Window {
  readonly id: string;
  /** The session key of the window's project: its storage root. */
  readonly key: string;
  /** The project folder, as the notices name it. */
  readonly project: string;
  readonly capabilities: ReadonlySet<HostCapability>;
  focusedAt: number;
  readonly calls: WindowCalls;
  /** One reply of the window to its client here. */
  readonly reply: (
    message: RpcMessage.FromServerEncoded,
  ) => Effect.Effect<void>;
}

/** The project folder a session holds, or its store for a session with
 *  no folder. */
const projectOf = (session: Session): string =>
  session.roots.workspace ?? session.roots.storage;

/**
 * The windows attached to this process, the calls they owe an answer, and
 * what each project's windows offer its runs' editor tools (`editors`): the
 * one record of the attachments. A composition makes it before its plugins,
 * which read `editors`, and serves {@link HostWindows} over it.
 */
export const makeWindowTable = () => {
  const windows = new Set<Window>();

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

  /** Send a call nothing waits on past the window having it: the window
   *  carries it out and says itself when it could not. A window that went
   *  first has it nowhere, which only its log here says. */
  const tell = (
    told: Effect.Effect<void, RpcClientError.RpcClientError>,
  ): Effect.Effect<void> =>
    told.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning('A TeXRA window did not take a host call').pipe(
          Effect.annotateLogs({ data: cause }),
        ),
      ),
    );

  /** Call the window `key`'s project routes `kind` to and wait for its
   *  answer, for as long as the kind is waited on. The window going first
   *  ends its client here, which ends the call. */
  const ask = <K extends keyof typeof ASKED_WITHIN, A>(
    key: string,
    kind: K,
    call: (
      calls: WindowCalls,
    ) => Effect.Effect<A, HostCallFailed | RpcClientError.RpcClientError>,
  ): Effect.Effect<A, WindowCallFailed> =>
    Effect.suspend(() => {
      const window = target(key, kind);
      if (window === undefined)
        return Effect.fail(
          new WindowCallFailed({
            reason: 'detached',
            message: 'No TeXRA window of this project is attached.',
          }),
        );
      const within = ASKED_WITHIN[kind];
      return call(window.calls).pipe(
        Effect.mapError(
          (error) =>
            new WindowCallFailed({ reason: 'failed', message: error.message }),
        ),
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
        // A reply that did not decode is the window's; a call ended with no
        // reply at all is its client closing as the window detached.
        Effect.catchCause((cause) =>
          Cause.hasFails(cause)
            ? Effect.failCause(cause)
            : Effect.fail(
                Cause.hasDies(cause)
                  ? new WindowCallFailed({
                      reason: 'failed',
                      message: `The TeXRA window answered ${kind} with a value it does not take.`,
                    })
                  : new WindowCallFailed({
                      reason: 'detached',
                      message: 'The TeXRA window closed before it answered.',
                    }),
              ),
        ),
      );
    });

  /** The window went: its project hears once when no window of it is
   *  left. What it was asked ends as its client here closes. */
  const detach = Effect.fn('detach')(function* (window: Window) {
    windows.delete(window);
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
          : tell(window.calls.notices({ notice }, { discard: true }));
      },
    };
  };
  /** What `key`'s project's windows offer its runs' editor tools,
   *  routed to the window focused last that offers each. */
  const editorOf = (key: string): EditorCapabilities => ({
    get readDiagnostics(): EditorCapabilities['readDiagnostics'] {
      if (!offers(key, 'readDiagnostics')) return undefined;
      return (path: string) =>
        ask(key, 'readDiagnostics', (calls) =>
          calls.readDiagnostics({ path }),
        ).pipe(
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
      return (entry) =>
        ask(key, 'addCriticism', (calls) => calls.addCriticism({ entry }));
    },
    get openPdf(): EditorCapabilities['openPdf'] {
      if (!offers(key, 'openPdf')) return undefined;
      return ({ location, preserveFocus }) =>
        ask(key, 'openPdf', (calls) =>
          calls.openPdf({ location, preserveFocus }),
        ).pipe(
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
  /** A window's reply to a call of its client here. */
  const answer = (attachment: string, message: unknown) =>
    Effect.suspend(() => {
      for (const window of windows)
        if (window.id === attachment)
          // cast: `rpc` reads its own message, and a reply it cannot read
          // fails the call it answers.
          return window.reply(
            message as unknown as RpcMessage.FromServerEncoded,
          );
      return Effect.logWarning(
        `A TeXRA window answered a host call after its attachment ${attachment} ended`,
      );
    });
  const focus = (attachment: string) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      for (const window of windows)
        if (window.id === attachment) window.focusedAt = now;
    });
  return {
    windows,
    detach,
    interactionsOf,
    answer,
    focus,
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
        (window) =>
          tell(window.calls.filesWritten({ absolutePaths }, { discard: true })),
        { discard: true },
      ),
    /** What a session's project's windows offer its runs' editor tools, by
     *  the session's storage root: read live, so a capability is offered
     *  exactly while a window of the project offers it. */
    editors: editorRegistry(editorOf),
  };
};
type WindowTable = ReturnType<typeof makeWindowTable>;

const make = Effect.fn('make')(function* (table: WindowTable) {
  const { windows, detach, interactionsOf, answer, focus } = table;
  // Each session's presentation surface, held while a window of it is
  // attached. A session is a key by identity: a project reopened after an
  // idle close is a new session, given its own.
  const surfaces = yield* RcMap.make({
    lookup: (session: Session) => session.attach(interactionsOf(session)),
  });

  /** Attach a window of `session`'s project offering `capabilities`: its
   *  id, then the calls for it, until the stream ends (the window went). */
  const attach = (
    session: Session,
    capabilities: readonly HostCapability[],
  ): Stream.Stream<HostAttachFrame> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const frames = yield* Queue.bounded<HostAttachFrame>(CALLS_AHEAD);
        const { protocol, receive } = yield* callOverMessages((message) =>
          // cast: `rpc`'s messages are JSON.
          Queue.offer(frames, {
            kind: 'call',
            message: message as unknown as typeof Schema.Json.Type,
          }).pipe(Effect.asVoid),
        );
        // Closed after the window is unlisted (finalizers run last-in
        // first-out): a call still waiting then ends as detached.
        const calls = yield* RpcClient.make(WindowRpcs).pipe(
          Effect.provideService(RpcClient.Protocol, protocol),
        );
        const window: Window = {
          id: randomUUID(),
          key: session.roots.storage,
          project: projectOf(session),
          capabilities: new Set(capabilities),
          focusedAt: yield* Clock.currentTimeMillis,
          calls,
          reply: receive,
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
          Stream.fromQueue(frames),
        );
      }),
    );
  return {
    attach,
    filesWritten: table.filesWritten,
    /** A window was focused: its project's calls go to it first. */
    focus,
    /** A window's answer to one call. */
    answer,
    /** The link a window of `session`, a session this process opened,
     *  attaches through: always this process, never away. */
    localLink: (session: Session): Effect.Effect<ServiceLink<WindowClient>> =>
      Effect.zipWith(
        SubscriptionRef.make<Linked<WindowClient>>({
          client: {
            'host.attach': ({ capabilities }) => attach(session, capabilities),
            'host.answer': (input) => answer(input.attachment, input.message),
            'host.focus': ({ attachment }) => focus(attachment),
          },
        }),
        Ref.make(false),
        linkOver,
      ),
  };
});

/** The windows attached to this process, served on every host's process
 *  runtime over the window table its plugins' editor tools read. */
export class HostWindows extends Context.Service<
  HostWindows,
  Effect.Success<ReturnType<typeof make>>
>()('@texra-ai/texra/server/HostWindows') {
  static readonly layer = (table: WindowTable) =>
    Layer.effect(HostWindows, make(table));
}
