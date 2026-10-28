/**
 * The windows attached to the service, and the one presentation surface the
 * service gives each project's session: a run that asks for a host
 * capability (a file's diagnostics, an inline criticism, a PDF to open, a
 * notice) is answered by a window of that project.
 *
 * A call goes only to a window of the session's project: among those that
 * offer the capability, the one focused last. A call that waits for its
 * answer fails, typed, when that window detaches or does not answer in
 * time; nothing waits forever. With no window of the project attached, a
 * capability is absent, as it is in a headless process, and the service
 * says so once each time the project's last window goes. The service keeps
 * no window state beyond the attachments themselves, and a call's answer
 * reaches the run's history only through the tool result that used it.
 */
import { randomUUID } from 'node:crypto';
import { isPathWithin } from '@texra-ai/harness/host';

import {
  Clock,
  Deferred,
  type Duration,
  Effect,
  Queue,
  Result,
  Schema,
  type Scope,
  Stream,
} from 'effect';

import {
  DiagnosticsReadFailed,
  PdfOpenFailed,
  type EditorCapabilities,
  type EditorHostShape,
} from '@texra/tools/editorHost';

import {
  CALL_CAPABILITY,
  CallResultSchemas,
  type HostAnswer,
  type HostCall,
  type HostCapability,
  type HostFrame,
  type Notice,
} from './hostCalls';
import type { Session, SessionHost } from '@texra-ai/harness';

/** Why a call a run waited on got no answer from a window. */
export class WindowCallFailed extends Schema.TaggedError<WindowCallFailed>()(
  'WindowCallFailed',
  {
    /** `detached`: the window went before it answered; `no-answer`: it did
     *  not answer in time; `failed`: it answered with its own failure. */
    reason: Schema.Literals(['detached', 'no-answer', 'failed']),
    message: Schema.String,
  },
) {}

/** How long a run waits for each answer. A diagnostics read may build the
 *  document first, so it waits longest. */
const ANSWER_WITHIN = {
  readDiagnostics: '2 minutes',
  addCriticism: '10 seconds',
  openPdf: '30 seconds',
} satisfies Partial<Record<HostCall['kind'], Duration.Input>>;
type AnsweredCall = Extract<HostCall, { kind: keyof typeof ANSWER_WITHIN }>;

interface Window {
  readonly id: string;
  /** The session key of the window's project: its storage root. */
  readonly key: string;
  /** The project folder, as the service's notices name it. */
  readonly project: string;
  readonly capabilities: ReadonlySet<HostCapability>;
  focusedAt: number;
  readonly frames: Queue.Queue<HostFrame>;
  /** The calls it has not answered yet, by call id: what each answer
   *  does, and how the call fails when the window goes. */
  readonly pending: Map<string, PendingCall>;
}

interface PendingCall {
  readonly answer: (answer: HostAnswer) => Effect.Effect<void>;
  readonly fail: (failure: WindowCallFailed) => Effect.Effect<void>;
}

const answerFailure = (
  answer: Extract<HostAnswer, { ok: false }>,
): WindowCallFailed =>
  new WindowCallFailed({
    reason: 'failed',
    message: answer.message,
  });

/** The project folder a session holds, or its store for a session with
 *  no folder. */
const projectOf = (session: Session): string =>
  session.roots.workspace ?? session.roots.storage;

/** The service's attached windows. */
export interface HostWindows {
  /** Attach a window of `session`'s project offering `capabilities`: its
   *  id, then the calls for it, until the stream ends (the window went). */
  readonly attach: (
    session: Session,
    capabilities: readonly HostCapability[],
  ) => Stream.Stream<HostFrame>;
  /** Files a task wrote past the editor's own write path, as this
   *  process's announcer heard them from the task's rows: every window
   *  whose project holds one hears it, so its file tree and decorations
   *  follow the service's tasks. */
  readonly filesWritten: (
    absolutePaths: readonly string[],
  ) => Effect.Effect<void>;
  /** The window was focused: its project's calls go to it first. */
  readonly focus: (attachment: string) => Effect.Effect<void>;
  /** A window's answer to one call. */
  readonly answer: (id: string, answer: HostAnswer) => Effect.Effect<void>;
  /** Give `session` the forwarding surface, and attach its project's
   *  windows' editors to `editors`, for the scope's life. */
  readonly adopt: (
    session: Session,
    editors: EditorHostShape,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export const makeHostWindows = Effect.sync((): HostWindows => {
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

  /** Send a call that needs no answer. */
  const tell = (window: Window | undefined, call: HostCall) =>
    window === undefined
      ? Effect.void
      : Queue.offer(window.frames, {
          kind: 'call',
          id: randomUUID(),
          call,
        }).pipe(Effect.asVoid);

  /** Send a call to the window `key`'s project routes it to and wait for
   *  its answer, decoded by `schema`. */
  const ask = <A>(
    key: string,
    call: AnsweredCall,
    schema: Schema.Codec<A, unknown>,
  ): Effect.Effect<A, WindowCallFailed> =>
    Effect.gen(function* () {
      const window = target(key, CALL_CAPABILITY[call.kind]);
      const within = ANSWER_WITHIN[call.kind];
      const answered = Deferred.makeUnsafe<unknown, WindowCallFailed>();
      // Registered in the same step that checks the window is attached, so
      // a detach either finds this call or came before it.
      if (window === undefined || !windows.has(window))
        return yield* new WindowCallFailed({
          reason: 'detached',
          message: 'No TeXRA window of this project is attached.',
        });
      const id = randomUUID();
      window.pending.set(id, {
        answer: (answer) =>
          answer.ok
            ? Deferred.succeed(answered, answer.value).pipe(Effect.asVoid)
            : Deferred.fail(answered, answerFailure(answer)).pipe(
                Effect.asVoid,
              ),
        fail: (failure) => Deferred.fail(answered, failure).pipe(Effect.asVoid),
      });
      calls.set(id, window);
      yield* Queue.offer(window.frames, { kind: 'call', id, call });
      const value = yield* Deferred.await(answered).pipe(
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
        Effect.ensuring(
          Effect.sync(() => {
            window.pending.delete(id);
            calls.delete(id);
          }),
        ),
      );
      const parsed = Schema.decodeUnknownResult(schema)(value);
      if (!Result.isSuccess(parsed))
        return yield* new WindowCallFailed({
          reason: 'failed',
          message: `The TeXRA window answered ${call.kind} with a value it does not take.`,
        });
      return parsed.success;
    });

  /** The window went: what it was asked fails, and its project hears once
   *  when no window of it is left. */
  const detach = (window: Window) =>
    Effect.gen(function* () {
      windows.delete(window);
      for (const [id, pending] of window.pending) {
        calls.delete(id);
        yield* pending.fail(
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
        // The notice's own schema checks it on the window's side of the wire.
        const notice = { event, payload } as Notice;
        return window === undefined
          ? Effect.logWarning(`Service notice ${event}`).pipe(
              Effect.annotateLogs({ data: payload }),
            )
          : tell(window, { kind: 'notice', notice });
      },
      approvalDenied: (denial, runId) => {
        const window = target(key, 'notices');
        if (window !== undefined)
          Queue.offerUnsafe(window.frames, {
            kind: 'call',
            id: randomUUID(),
            call: { kind: 'approvalDenied', denial, runId },
          });
      },
    };
  };
  /** What `session`'s project's windows offer its runs' editor tools,
   *  routed to the window focused last that offers each. */
  const editorOf = (key: string): EditorCapabilities => ({
    get readDiagnostics(): EditorCapabilities['readDiagnostics'] {
      if (!offers(key, 'readDiagnostics')) return undefined;
      return (path: string) =>
        ask(
          key,
          { kind: 'readDiagnostics', path },
          CallResultSchemas.readDiagnostics,
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
        ask(
          key,
          { kind: 'addCriticism', entry },
          CallResultSchemas.addCriticism,
        );
    },
    get openPdf(): EditorCapabilities['openPdf'] {
      if (!offers(key, 'openPdf')) return undefined;
      return ({ location, preserveFocus }) =>
        ask(
          key,
          { kind: 'openPdf', location, preserveFocus },
          Schema.Null,
        ).pipe(
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
  return {
    attach: (session, capabilities) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const window: Window = {
            id: randomUUID(),
            key: session.roots.storage,
            project: projectOf(session),
            capabilities: new Set(capabilities),
            focusedAt: yield* Clock.currentTimeMillis,
            frames: yield* Queue.unbounded<HostFrame>(),
            pending: new Map(),
          };
          windows.add(window);
          return Stream.concat(
            Stream.succeed<HostFrame>({
              kind: 'attached',
              attachment: window.id,
            }),
            Stream.fromQueue(window.frames),
          ).pipe(Stream.ensuring(detach(window)));
        }),
      ),
    filesWritten: (absolutePaths) =>
      Effect.forEach(
        [...windows].filter(
          (window) =>
            window.capabilities.has('notices') &&
            absolutePaths.some((path) => isPathWithin(window.project, path)),
        ),
        (window) => tell(window, { kind: 'filesWritten', absolutePaths }),
        { discard: true },
      ),
    focus: (attachment) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        for (const window of windows)
          if (window.id === attachment) window.focusedAt = now;
      }),
    answer: (id, answer) =>
      Effect.suspend(
        () => calls.get(id)?.pending.get(id)?.answer(answer) ?? Effect.void,
      ),
    adopt: Effect.fn('hostWindows.adopt')(function* (session, editors) {
      const key = session.roots.storage;
      yield* session.attach(interactionsOf(session));
      yield* editors.attach(key, editorOf(key));
    }),
  };
});
