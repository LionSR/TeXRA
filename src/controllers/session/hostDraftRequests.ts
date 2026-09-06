/** Shared draft operations and the process recorder's originating request. */
import { Deferred, Effect } from 'effect';

import { runInSession } from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { polishTextWithAI } from '@agent/runtime/textEnhancement';
import { effectRuntime } from '@platform/processRuntime';
import type { HostRequest } from '@shared/session/hostRequest';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import { Cancelled, Rejected } from '@shared/session/requestErrors';
import type { HostOutcome } from '@shared/session/sessionFrames';
import {
  killActiveRecording,
  startRecording,
  stopRecordingAndTranscribe,
} from '@tools/media/audio';
import { savePastedImageBase64 } from '@utils/files/pastedImageUtils';

type DraftRequest = Extract<
  HostRequest,
  { kind: 'record' | 'polish' | 'savePastedImage' }
>;
type Recording = NonNullable<HostSnapshot['recording']>;

interface Take {
  readonly session: SessionHandle;
  readonly port: string;
  readonly descriptor: Recording;
  /** Start's answer: the transcription, or why the take ended without one. */
  readonly result: Deferred.Deferred<HostOutcome, unknown>;
  /** Settled by the first Stop or Cancel. The take fiber waits on it once
   *  the microphone is up, then reads `cancelled` to decide what to do. */
  readonly settled: Deferred.Deferred<void>;
  stopping: boolean;
  cancelled: boolean;
}

/** One instance per host process, shared by its session request handlers. */
export class HostDraftRequests {
  private take: Take | null = null;
  private readonly listeners = new Set<(recording: Recording | null) => void>();

  /** Bind one session's requests, recorder level, and disposal together. */
  attach(
    session: SessionHandle,
    onRecording: (recording: Recording | null) => void,
  ) {
    const stopObserving = this.subscribe(onRecording);
    return {
      handle: (request: DraftRequest, port: string) =>
        this.handle(session, request, port),
      closePort: (port: string) => this.cancel(session, port),
      dispose: () => {
        stopObserving();
        this.cancel(session);
      },
    };
  }

  /** Every open paper observes the same recorder and its destination. */
  subscribe(listener: (recording: Recording | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.recording());
    return () => this.listeners.delete(listener);
  }

  handle(
    session: SessionHandle,
    request: DraftRequest,
    port: string,
  ): Promise<HostOutcome> {
    return effectRuntime().runPromise(this.draft(session, request, port));
  }

  private readonly draft = Effect.fn('HostDraftRequests.handle')(function* (
    this: HostDraftRequests,
    session: SessionHandle,
    request: DraftRequest,
    port: string,
  ): Effect.fn.Return<HostOutcome, unknown> {
    switch (request.kind) {
      case 'polish': {
        const result = yield* Effect.tryPromise({
          try: () => polishTextWithAI(request.text, undefined, session),
          catch: (error) => error,
        });
        if (!result.success) {
          return yield* new Rejected({
            reason: result.error ?? 'Polishing failed.',
          });
        }
        return { kind: 'text', text: result.text };
      }
      case 'savePastedImage':
        return {
          kind: 'savedImage',
          fileName: yield* Effect.tryPromise({
            try: () => savePastedImageBase64(request.base64, request.fileName),
            catch: (error) => error,
          }),
        };
      case 'record':
        if (request.action.kind === 'start') {
          return yield* this.start(session, port, request.action.target);
        }
        this.stop();
        return { kind: 'done' };
    }
  });

  /** Closing the originating session discards its take without transcription. */
  cancel(session: SessionHandle, port?: string): void {
    const take = this.take;
    if (
      !take ||
      take.session !== session ||
      (port !== undefined && take.port !== port)
    )
      return;
    take.cancelled = true;
    Deferred.doneUnsafe(take.result, Effect.fail(new Cancelled()));
    this.notify();
    Deferred.doneUnsafe(take.settled, Effect.void);
  }

  private readonly start = Effect.fn('HostDraftRequests.start')(function* (
    this: HostDraftRequests,
    session: SessionHandle,
    port: string,
    target: string,
  ) {
    if (this.take) {
      return yield* new Rejected({
        reason: 'A recording is already in progress.',
      });
    }
    const take: Take = {
      session,
      port,
      descriptor: { session: session.roots.storage, target },
      result: yield* Deferred.make<HostOutcome, unknown>(),
      settled: yield* Deferred.make<void>(),
      stopping: false,
      cancelled: false,
    };
    // Reserve the process recorder before asynchronous microphone startup.
    this.take = take;
    this.notify();
    // Detached on purpose: the take belongs to this recorder, not to the
    // Start request. Start can be answered early (Cancel) while the take
    // still has to wait for the microphone and kill it; `release` ends it.
    yield* Effect.forkDetach(this.runTake(take));
    return yield* Deferred.await(take.result);
  });

  /** The take from microphone startup to its answer. Completion belongs to
   *  Start, even when another paper or view stops the recorder. */
  private readonly runTake = Effect.fn('HostDraftRequests.take')(function* (
    this: HostDraftRequests,
    take: Take,
  ) {
    const takeProgram: Effect.Effect<HostOutcome, unknown> = Effect.gen(
      function* () {
        const started = yield* Effect.tryPromise({
          try: async () => runInSession(take.session, startRecording),
          catch: (error) => error,
        });
        if (!started.success) {
          return yield* new Rejected({
            reason: started.error ?? 'Recording could not start.',
          });
        }
        yield* Deferred.await(take.settled);
        if (take.cancelled) {
          killActiveRecording();
          return yield* new Rejected({
            reason: 'The recording was cancelled.',
          });
        }
        const result = yield* Effect.tryPromise({
          try: async () =>
            runInSession(take.session, stopRecordingAndTranscribe),
          catch: (error) => error,
        });
        if (!result.success) {
          return yield* new Rejected({
            reason: result.error ?? 'Transcription failed.',
          });
        }
        return { kind: 'text', text: result.text };
      },
    );
    // A cancelled take already has its answer; `into` leaves it in place.
    yield* takeProgram.pipe(
      Deferred.into(take.result),
      Effect.ensuring(Effect.sync(() => this.release(take))),
    );
  });

  private stop(): void {
    const take = this.take;
    if (!take || take.stopping || take.cancelled) return;
    take.stopping = true;
    this.notify();
    // Stop acknowledges its own request; the take fiber transcribes.
    Deferred.doneUnsafe(take.settled, Effect.void);
  }

  private recording(): Recording | null {
    const take = this.take;
    return take && !take.stopping && !take.cancelled ? take.descriptor : null;
  }

  private notify(): void {
    const recording = this.recording();
    for (const listener of this.listeners) listener(recording);
  }

  private release(take: Take): void {
    if (this.take !== take) return;
    this.take = null;
    this.notify();
  }
}
