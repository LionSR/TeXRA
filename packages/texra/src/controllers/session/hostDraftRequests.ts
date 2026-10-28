/** Shared draft operations and the process recorder's originating request. */
import { Buffer } from 'node:buffer';

import { Deferred, Effect, Fiber, FileSystem } from 'effect';
import { MODEL_CONFIGS } from '@texra-ai/llm';

import { Cancelled, Rejected, type WorkspaceRoots } from '@texra-ai/harness';
import {
  AppState,
  ownKeyCredential,
  Secrets,
  withLogChannel,
} from '@texra-ai/harness/host';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import type { HostRequest } from '@texra/shared/session/hostRequest';
import type { HostOutcome } from '@texra/shared/session/sessionFrames';
import { polishTextWithAI } from '@texra/agent/runtime/textEnhancement';
import {
  recordingsDir,
  startRecording,
  validateRecordingFile,
  transcribeRecording,
} from '@texra/tools/media/audio';
import {
  savePastedImageBuffer,
  sweepStaleFiles,
  type PastedImageSaveFailed,
} from '@texra/utils/files/pastedImageUtils';
import type { StorageFs } from '@texra-ai/harness/host';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const CHANNEL = 'HostDraftRequests';

type DraftRequest = Extract<
  HostRequest,
  { kind: 'record' | 'polish' | 'savePastedImage' }
>;
type Recording = NonNullable<HostSnapshot['recording']>;

interface Take {
  readonly roots: WorkspaceRoots;
  readonly port: string;
  readonly descriptor: Recording;
  /** Start's answer: the transcription, or why the take ended without one. */
  readonly result: Deferred.Deferred<HostOutcome, Rejected | Cancelled>;
  /** Settled by the first Stop or Cancel. The take fiber waits on it once
   *  the microphone is up, then reads `cancelled` to decide what to do. */
  readonly settled: Deferred.Deferred<void>;
  stopping: boolean;
  cancelled: boolean;
}

/** One instance per host process, shared by its session request handlers. */
export class HostDraftRequests {
  private take: Take | null = null;
  /** The detached fiber of the latest take; {@link shutdown} interrupts it. */
  private takeFiber: Fiber.Fiber<void> | null = null;
  private readonly listeners = new Set<(recording: Recording | null) => void>();

  /** Bind one session's requests and recorder level for the caller's scope;
   *  closing it stops observing and discards the session's take. */
  attach(
    roots: WorkspaceRoots,
    onRecording: (recording: Recording | null) => void,
  ) {
    return Effect.acquireRelease(
      Effect.sync(() => this.subscribe(onRecording)),
      (stopObserving) =>
        Effect.sync(() => {
          stopObserving();
          this.cancel(roots);
        }),
    ).pipe(
      Effect.as({
        handle: (request: DraftRequest, port: string) =>
          this.handle(roots, request, port),
        closePort: (port: string) => this.cancel(roots, port),
      }),
    );
  }

  /** Every open paper observes the same recorder and its destination. */
  subscribe(listener: (recording: Recording | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.recording());
    return () => this.listeners.delete(listener);
  }

  /** Answer one draft request of the session at `roots`, on `port`. The host
   *  that took the request runs this where it stands. */
  readonly handle = Effect.fn('HostDraftRequests.handle')(function* (
    this: HostDraftRequests,
    roots: WorkspaceRoots,
    request: DraftRequest,
    port: string,
  ): Effect.fn.Return<
    HostOutcome,
    Rejected | Cancelled | PastedImageSaveFailed,
    | AppState
    | Secrets
    | FileSystem.FileSystem
    | StorageFs
    | ChildProcessSpawner
    // The polish's helper call: its model, client, usage log and retry gate.
    | Effect.Services<ReturnType<typeof polishTextWithAI>>
  > {
    switch (request.kind) {
      case 'polish': {
        const text = yield* polishTextWithAI(request.text, roots).pipe(
          Effect.mapError((error) => new Rejected({ reason: error.message })),
        );
        return { kind: 'text', text };
      }
      case 'savePastedImage':
        return {
          kind: 'savedImage',
          fileName: yield* savePastedImageBuffer(
            Buffer.from(request.base64, 'base64'),
            request.fileName,
          ),
        };
      case 'record':
        if (request.action.kind === 'start') {
          return yield* this.start(roots, port, request.action.target);
        }
        this.stop();
        return { kind: 'done' };
    }
  });

  /** Closing the originating session discards its take without transcription. */
  cancel(roots: WorkspaceRoots, port?: string): void {
    const take = this.take;
    if (
      !take ||
      take.roots !== roots ||
      (port !== undefined && take.port !== port)
    )
      return;
    take.cancelled = true;
    Deferred.doneUnsafe(take.result, Effect.fail(new Cancelled()));
    this.notify();
    Deferred.doneUnsafe(take.settled, Effect.void);
  }

  /** Host shutdown: answer the current take as cancelled and interrupt its
   *  fiber, whose scope stops sox and joins its exit before this returns. */
  readonly shutdown: Effect.Effect<void> = Effect.suspend(() => {
    if (this.take) this.cancel(this.take.roots);
    return this.takeFiber ? Fiber.interrupt(this.takeFiber) : Effect.void;
  });

  private readonly start = Effect.fn('HostDraftRequests.start')(function* (
    this: HostDraftRequests,
    roots: WorkspaceRoots,
    port: string,
    target: string,
  ) {
    if (this.take) {
      return yield* new Rejected({
        reason: 'A recording is already in progress.',
      });
    }
    // The check above and this reservation are one synchronous step: a
    // `yield*` between them would let a second Start pass the check too and
    // put two recorders on the microphone.
    const take: Take = {
      roots,
      port,
      descriptor: { session: roots.storage, target },
      result: Deferred.makeUnsafe<HostOutcome, Rejected | Cancelled>(),
      settled: Deferred.makeUnsafe<void>(),
      stopping: false,
      cancelled: false,
    };
    // Reserve the process recorder before asynchronous microphone startup.
    this.take = take;
    this.notify();
    // Detached on purpose: the take belongs to this recorder, not to the
    // Start request. Start can be answered early (Cancel) while the take
    // still has to wait for the microphone and kill it; `release` ends it.
    this.takeFiber = yield* Effect.forkDetach(this.runTake(take));
    return yield* Deferred.await(take.result);
  });

  /** The take from microphone startup to its answer. Completion belongs to
   *  Start, even when another paper or view stops the recorder. */
  private readonly runTake = Effect.fn('HostDraftRequests.take')(function* (
    this: HostDraftRequests,
    take: Take,
  ) {
    const takeProgram: Effect.Effect<
      HostOutcome,
      Rejected | Cancelled,
      Secrets | FileSystem.FileSystem | ChildProcessSpawner
    > = Effect.gen(function* () {
      // sox lives in this block's scope. Its close (SIGTERM, then a join on
      // the exit) is the stop, so the microphone is off before anything
      // below reads a credential. The recorder writes under the take's own
      // session storage, so its roots travel with the call.
      const capturedPath = yield* Effect.scoped(
        Effect.gen(function* () {
          const recorder = yield* startRecording(take.roots).pipe(
            Effect.mapError((error) => new Rejected({ reason: error.message })),
          );
          // sox exiting before Stop or Cancel ends the take, a clean exit
          // included: the microphone is no longer recording.
          yield* Effect.raceFirst(
            Deferred.await(take.settled),
            recorder.handle.exitCode.pipe(
              Effect.mapError((error) => error.message),
              Effect.flatMap((code) =>
                Effect.fail(`sox exited with code ${code}`),
              ),
              Effect.mapError(
                (reason) =>
                  new Rejected({
                    reason: `Recording stopped unexpectedly: ${reason}`,
                  }),
              ),
              Effect.tapError((error) => Effect.logWarning(error.reason)),
            ),
          );
          if (take.cancelled) {
            return yield* new Rejected({
              reason: 'The recording was cancelled.',
            });
          }
          return recorder.path;
        }),
      );
      const recordingPath = yield* validateRecordingFile(capturedPath).pipe(
        Effect.mapError((error) => new Rejected({ reason: error.message })),
      );
      // The transcription endpoint is an OpenAI SDK operation the llm
      // package does not model, so it calls OpenAI directly:
      // `gpt-4o-transcribe` is an OpenAI-only endpoint model. The take holds no session frame to enter — its
      // roots travel with each call — so the endpoint read runs in the
      // calling frame, and the resolved credential reaches the
      // transcription as data.
      const postStop = Effect.gen(function* () {
        const credential = yield* ownKeyCredential(
          take.roots,
          MODEL_CONFIGS['openai/gpt-4o-2024-11-20'],
          'openai',
        ).pipe(
          Effect.mapError((error) => new Rejected({ reason: error.message })),
        );
        const text = yield* transcribeRecording(recordingPath, credential).pipe(
          Effect.mapError((error) => new Rejected({ reason: error.message })),
        );
        // The sweep is rooted by the take's storage root, as data, rather
        // than by an ambient read of the calling fiber's roots.
        yield* sweepStaleFiles(
          yield* FileSystem.FileSystem,
          recordingsDir(take.roots),
        );
        return { kind: 'text', text } satisfies HostOutcome;
      });
      // A Cancel after Stop answers Start and interrupts the upload here.
      // raceFirst starts both arms, so postStop may begin before a cancel that
      // already landed is observed; the cancel still wins and interrupts it.
      return yield* Effect.raceFirst(Deferred.await(take.result), postStop);
    });
    // A cancelled take already has its answer; `into` leaves it in place.
    // The take's warnings (an unexpected sox exit, the stale-take sweep)
    // stay on this channel.
    yield* takeProgram.pipe(
      withLogChannel(CHANNEL),
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
