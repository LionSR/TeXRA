/**
 * The windows attached to the service, and the one presentation surface the
 * service gives each project's session: a run that asks for a host
 * capability (a file's diagnostics, an inline criticism, a PDF to open, a
 * tool edit's preview, a notice) is answered by a window of that project.
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

import { ModelError, type ModelErrorFieldsSchema } from '@texra-ai/llm';
import {
  type Cause,
  Data,
  Deferred,
  type Duration,
  Effect,
  Queue,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import { z } from 'zod';

import type { HostInteractions } from '@agent/runtime/HostInteractions';
import {
  DiagnosticsReadFailed,
  PdfOpenFailed,
} from '@agent/runtime/runtimePresentationEvents';
import type { SessionHandle } from '@agent/runtime/SessionHandle';

import {
  CALL_CAPABILITY,
  CallResultSchemas,
  type HostAnswer,
  type HostCall,
  type HostCapability,
  type HostFrame,
  type Notice,
} from './hostCalls';
import type { ToolEditPreview } from './protocol';

/** Why a call a run waited on got no answer from a window. */
export class WindowCallFailed extends Data.TaggedError('WindowCallFailed')<{
  /** `detached`: the window went before it answered; `no-answer`: it did
   *  not answer in time; `failed`: it answered with its own failure. */
  readonly reason: 'detached' | 'no-answer' | 'failed';
  readonly message: string;
  /** A model's failure, as the window's model raised it. */
  readonly model?: z.infer<typeof ModelErrorFieldsSchema>;
}> {}

/** A model call's failure as the run's model binding sees it: the
 *  window's own, or the window's absence as a transport failure. */
const modelError = (failure: WindowCallFailed): ModelError =>
  new ModelError(
    failure.model ?? {
      kind: 'transport',
      message: `The VS Code window serving this editor model ${failure.reason === 'failed' ? 'failed' : 'is gone'}: ${failure.message}`,
    },
  );

/** How long a run waits for each answer. A diagnostics read may build the
 *  document first, so it waits longest. */
const ANSWER_WITHIN = {
  readDiagnostics: '2 minutes',
  addCriticism: '10 seconds',
  openPdf: '30 seconds',
  approveToolEdit: '30 seconds',
  lmModels: '30 seconds',
  lmPrepare: '30 seconds',
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
    ...(answer.model !== undefined && { model: answer.model }),
  });

type PresentedToolEdit = Extract<
  HostCall,
  { kind: 'presentToolEdit' }
>['request'];

/** A staged tool edit, and the window that staged it: a window of the
 *  project that attaches while none holds it stages it there. `seen` marks
 *  one whose request the session has listed. */
interface Staged {
  readonly request: PresentedToolEdit;
  window: Window | undefined;
  seen: boolean;
}

const previewOf = (entry: Staged | undefined): ToolEditPreview | null =>
  entry === undefined
    ? null
    : {
        originalContent: entry.request.originalContent,
        proposedContent: entry.request.proposedContent,
      };

/** The project folder a session holds, or its store for a session with
 *  no folder. */
const projectOf = (session: SessionHandle): string =>
  session.roots.workspace ?? session.roots.storage;

/** The service's attached windows. */
export interface HostWindows {
  /** Attach a window of `session`'s project offering `capabilities`: its
   *  id, then the calls for it, until the stream ends (the window went). */
  readonly attach: (
    session: SessionHandle,
    capabilities: readonly HostCapability[],
  ) => Stream.Stream<HostFrame>;
  /** The window was focused: its project's calls go to it first. */
  readonly focus: (attachment: string) => Effect.Effect<void>;
  /** A window's answer to one call. */
  readonly answer: (id: string, answer: HostAnswer) => Effect.Effect<void>;
  /** Give `session` the forwarding surface, for the scope's life. */
  readonly adopt: (
    session: SessionHandle,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** The staged preview of one of `session`'s pending requests. */
  readonly preview: (
    session: SessionHandle,
    requestId: string,
  ) => Effect.Effect<ToolEditPreview | null>;
}

export const makeHostWindows = Effect.sync((): HostWindows => {
  const windows = new Set<Window>();
  /** Every unanswered call's window, by call id. */
  const calls = new Map<string, Window>();
  const staged = new Map<string, Map<string, Staged>>();
  const stagedIn = (key: string) => {
    const held = staged.get(key) ?? new Map<string, Staged>();
    staged.set(key, held);
    return held;
  };

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

  /** Send a call to `window` (by default the one `key`'s project routes it
   *  to) and wait for its answer, decoded by `schema`. */
  const ask = <A>(
    key: string,
    call: AnsweredCall,
    schema: z.ZodType<A>,
    window = target(key, CALL_CAPABILITY[call.kind]),
  ): Effect.Effect<A, WindowCallFailed> =>
    Effect.gen(function* () {
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
      const parsed = schema.safeParse(value);
      if (!parsed.success)
        return yield* new WindowCallFailed({
          reason: 'failed',
          message: `The TeXRA window answered ${call.kind} with a value it does not take.`,
        });
      return parsed.data;
    });

  /** Send a streamed call to the window `key`'s project routes it to: its
   *  items, decoded by `schema`, until its final answer. Ending early (the
   *  run stopped) tells the window to cancel; the window going fails it. */
  const askStream = <A>(
    key: string,
    call: Extract<HostCall, { kind: 'lmStream' }>,
    schema: z.ZodType<A>,
    window = target(key, CALL_CAPABILITY[call.kind]),
  ): Stream.Stream<A, WindowCallFailed> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Made first, so the check below and the registration are one step
        // and a detach either finds this call or came before it.
        const items = yield* Queue.unbounded<
          A,
          WindowCallFailed | Cause.Done
        >();
        if (window === undefined || !windows.has(window))
          return yield* new WindowCallFailed({
            reason: 'detached',
            message: 'No TeXRA window of this project is attached.',
          });
        const id = randomUUID();
        let settled = false;
        window.pending.set(id, {
          answer: (answer) => {
            if (!answer.ok) {
              settled = true;
              return Queue.fail(items, answerFailure(answer)).pipe(
                Effect.asVoid,
              );
            }
            if (answer.more !== true) {
              settled = true;
              return Queue.end(items).pipe(Effect.asVoid);
            }
            const item = schema.safeParse(answer.value);
            return item.success
              ? Queue.offer(items, item.data).pipe(Effect.asVoid)
              : Queue.fail(
                  items,
                  new WindowCallFailed({
                    reason: 'failed',
                    message: `The TeXRA window answered ${call.kind} with an item it does not take.`,
                  }),
                ).pipe(Effect.asVoid);
          },
          fail: (failure) => {
            settled = true;
            return Queue.fail(items, failure).pipe(Effect.asVoid);
          },
        });
        calls.set(id, window);
        yield* Queue.offer(window.frames, { kind: 'call', id, call });
        return Stream.fromQueue(items).pipe(
          Stream.ensuring(
            Effect.suspend(() => {
              window.pending.delete(id);
              calls.delete(id);
              return settled || !windows.has(window)
                ? Effect.void
                : tell(window, { kind: 'cancel', call: id });
            }),
          ),
        );
      }),
    );

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
          `No TeXRA window of ${window.project} is attached: its tasks run without diagnostics, inline criticism, PDF opening or editable tool-edit previews until one attaches.`,
        );
    });

  const interactionsOf = (session: SessionHandle): HostInteractions => {
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
      get readDiagnostics(): HostInteractions['readDiagnostics'] {
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
                    failure.reason === 'failed'
                      ? 'read-failed'
                      : failure.reason,
                  path,
                  message: failure.message,
                }),
            ),
          );
      },
      get addCriticism(): HostInteractions['addCriticism'] {
        if (!offers(key, 'addCriticism')) return undefined;
        return (entry) =>
          ask(
            key,
            { kind: 'addCriticism', entry },
            CallResultSchemas.addCriticism,
          );
      },
      get languageModel(): HostInteractions['languageModel'] {
        if (!offers(key, 'languageModel')) return undefined;
        return {
          selectModels: (selector) =>
            ask(
              key,
              { kind: 'lmModels', vendor: selector?.vendor ?? null },
              CallResultSchemas.lmModels,
            ).pipe(Effect.mapError((failure) => new Error(failure.message))),
          // The window holds the editor's model; a turn prepared in one
          // window streams in that window (its acquisition prepared it).
          acquire: (configuration) =>
            Effect.sync(() => {
              let preparedIn: Window | undefined;
              return {
                prepareTurn: (request) =>
                  Effect.suspend(() => {
                    preparedIn = target(key, 'languageModel');
                    return ask(
                      key,
                      { kind: 'lmPrepare', configuration, request },
                      CallResultSchemas.lmPrepare,
                      preparedIn,
                    );
                  }).pipe(Effect.mapError(modelError)),
                streamTurn: (turn) =>
                  askStream(
                    key,
                    { kind: 'lmStream', configuration, turn },
                    CallResultSchemas.lmStream,
                    preparedIn,
                  ).pipe(Stream.mapError(modelError)),
              };
            }),
        };
      },
      get openPdf(): HostInteractions['openPdf'] {
        if (!offers(key, 'openPdf')) return undefined;
        return ({ location, preserveFocus }) =>
          ask(key, { kind: 'openPdf', location, preserveFocus }, z.null()).pipe(
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
      // The service keeps every preview for `request.preview`; the window
      // that stages it as well is the one asked to release or approve it.
      presentToolEdit: (request) => {
        const { requestId } = request.permission;
        const entry: Staged = {
          request: {
            path: request.path,
            originalContent: request.originalContent,
            proposedContent: request.proposedContent,
            sourceTool: request.sourceTool,
            runId: request.runId ?? null,
            permission: request.permission,
          },
          window: undefined,
          seen: false,
        };
        stagedIn(key).set(requestId, entry);
        stage(entry, target(key, 'toolEdits'));
      },
      releaseToolEdit: (requestId) =>
        Effect.suspend(() => {
          const entry = stagedIn(key).get(requestId);
          stagedIn(key).delete(requestId);
          return tell(liveWindow(entry), {
            kind: 'releaseToolEdit',
            requestId,
          });
        }),
      approveToolEdit: (requestId) =>
        Effect.suspend(() => {
          const window = liveWindow(stagedIn(key).get(requestId));
          if (window === undefined) return Effect.succeed(false);
          // The window that staged it holds the user's edit, whichever
          // window is focused now.
          return ask(
            key,
            { kind: 'approveToolEdit', requestId },
            CallResultSchemas.approveToolEdit,
            window,
          ).pipe(
            Effect.catch((failure) =>
              Effect.logWarning(
                `The window's edit of ${requestId} was not read (${failure.message}); the edit is approved as proposed`,
              ).pipe(Effect.as(false)),
            ),
          );
        }),
    };
  };
  /** Stage `entry` in `window`, which then holds it. */
  const stage = (entry: Staged, window: Window | undefined) => {
    entry.window = window;
    if (window !== undefined)
      Queue.offerUnsafe(window.frames, {
        kind: 'call',
        id: randomUUID(),
        call: { kind: 'presentToolEdit', request: entry.request },
      });
  };
  /** The window that staged `entry`, while it is attached. */
  const liveWindow = (entry: Staged | undefined) =>
    entry?.window !== undefined && windows.has(entry.window)
      ? entry.window
      : undefined;

  return {
    attach: (session, capabilities) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const window: Window = {
            id: randomUUID(),
            key: session.roots.storage,
            project: projectOf(session),
            capabilities: new Set(capabilities),
            focusedAt: Date.now(),
            frames: yield* Queue.unbounded<HostFrame>(),
            pending: new Map(),
          };
          windows.add(window);
          // The project's tool edits no attached window holds (staged while
          // none was, or by one that went) are staged here, so this
          // window's Approve reads the edit it shows.
          if (window.capabilities.has('toolEdits'))
            for (const entry of stagedIn(window.key).values())
              if (liveWindow(entry) === undefined) stage(entry, window);
          return Stream.concat(
            Stream.succeed<HostFrame>({
              kind: 'attached',
              attachment: window.id,
            }),
            Stream.fromQueue(window.frames),
          ).pipe(Stream.ensuring(detach(window)));
        }),
      ),
    focus: (attachment) =>
      Effect.sync(() => {
        for (const window of windows)
          if (window.id === attachment) window.focusedAt = Date.now();
      }),
    answer: (id, answer) =>
      Effect.suspend(
        () => calls.get(id)?.pending.get(id)?.answer(answer) ?? Effect.void,
      ),
    adopt: (session) =>
      Effect.gen(function* () {
        const key = session.roots.storage;
        // A staged preview whose request the session listed and no longer
        // lists has settled: it is dropped, and its window releases its
        // view. One not listed yet is kept: staging precedes the row.
        yield* Effect.forkScoped(
          Stream.runForEach(SubscriptionRef.changes(session.view.ref), (view) =>
            Effect.gen(function* () {
              const held = stagedIn(key);
              if (held.size === 0) return;
              const pending = new Set(view.requests.map((r) => r.requestId));
              for (const [requestId, entry] of held) {
                if (pending.has(requestId)) entry.seen = true;
                else if (entry.seen) {
                  held.delete(requestId);
                  yield* tell(liveWindow(entry), {
                    kind: 'releaseToolEdit',
                    requestId,
                  });
                }
              }
            }),
          ),
        );
        yield* Effect.acquireRelease(
          session.interactions.use(interactionsOf(session)),
          (release) => Effect.sync(release),
        );
      }),
    preview: (session, requestId) =>
      Effect.map(SubscriptionRef.get(session.view.ref), (view) =>
        view.requests.some((request) => request.requestId === requestId)
          ? previewOf(stagedIn(session.roots.storage).get(requestId))
          : null,
      ),
  };
});
