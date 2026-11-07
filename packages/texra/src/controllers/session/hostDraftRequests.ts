/** Shared draft operations and the process recorder's originating request. */
import { Buffer } from 'node:buffer';

import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  FileSystem,
  Latch,
  SubscriptionRef,
} from 'effect';
import { MODEL_CONFIGS } from '@texra-ai/llm';

import { Cancelled, Rejected, type WorkspaceRoots } from '@texra-ai/harness';
import {
  AppState,
  ownKeyCredential,
  Secrets,
  withLogChannel,
} from '@texra-ai/harness/host';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import type { HostCommand } from '@texra/shared/session/hostRequest';
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
  HostCommand,
  { kind: 'record' | 'polish' | 'savePastedImage' }
>;
type Recording = NonNullable<HostSnapshot['recording']>;

/** Who started the take running now, and the latch its Stop opens. */
interface Take {
  readonly roots: WorkspaceRoots;
  readonly port: string;
  readonly stopped: Latch.Latch;
}

/** One instance per host process, shared by its session request handlers.
 *  The take runs in one fiber of the process's scope; `recording` is what
 *  every open project shows of it. */
export class HostDraftRequests {
  /** The recorder in the caller's (the process's) scope: closing it stops a
   *  take still running. */
  static readonly make = Effect.gen(function* () {
    return new HostDraftRequests(
      yield* SubscriptionRef.make<Recording | null>(null),
      yield* FiberHandle.make<HostOutcome, Rejected>(),
    );
  });

  /** The take recording now and where it is going; null once it stopped. */
  readonly recording: SubscriptionRef.SubscriptionRef<Recording | null>;
  private readonly takes: FiberHandle.FiberHandle<HostOutcome, Rejected>;
  /** The running take's owner; undefined while none runs. */
  private take: Take | undefined;
  private constructor(
    recording: SubscriptionRef.SubscriptionRef<Recording | null>,
    takes: FiberHandle.FiberHandle<HostOutcome, Rejected>,
  ) {
    this.recording = recording;
    this.takes = takes;
  }

  /** Bind one session's requests for the caller's scope; closing it
   *  discards the session's take. */
  attach(roots: WorkspaceRoots) {
    return Effect.acquireRelease(Effect.void, () => this.cancel(roots)).pipe(
      Effect.as({
        handle: (request: DraftRequest, port: string) =>
          this.handle(roots, request, port),
        closePort: (port: string) => this.cancel(roots, port),
      }),
    );
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
        yield* this.stop;
        return { kind: 'done' };
    }
  });

  /** Closing the originating session discards its take without
   *  transcription: the take is interrupted, which stops sox through its
   *  scope, or the upload when Stop came first. */
  cancel(roots: WorkspaceRoots, port?: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      const take = this.take;
      if (
        !take ||
        take.roots !== roots ||
        (port !== undefined && take.port !== port)
      )
        return Effect.void;
      return FiberHandle.clear(this.takes);
    });
  }

  /** Host shutdown: interrupt the current take and wait for sox to exit. */
  readonly shutdown: Effect.Effect<void> = Effect.suspend(() =>
    FiberHandle.clear(this.takes),
  );

  private readonly start = Effect.fn('HostDraftRequests.start')(function* (
    this: HostDraftRequests,
    roots: WorkspaceRoots,
    port: string,
    target: string,
  ) {
    const stopped = yield* Latch.make(false);
    if (this.take) {
      return yield* new Rejected({
        reason: 'A recording is already in progress.',
      });
    }
    // The check above and this reservation are one synchronous step: a
    // `yield*` between them would let a second Start pass the check too and
    // put two recorders on the microphone.
    const take: Take = { roots, port, stopped };
    this.take = take;
    yield* SubscriptionRef.set(this.recording, {
      session: roots.storage,
      target,
    });
    // The take runs in the recorder's own fiber, not the Start request's:
    // Start can be interrupted (its window closing) while the take still has
    // to wait for the microphone and kill it.
    const fiber = yield* FiberHandle.run(
      this.takes,
      this.runTake(take).pipe(
        Effect.ensuring(
          Effect.andThen(
            Effect.sync(() => {
              if (this.take === take) this.take = undefined;
            }),
            SubscriptionRef.set(this.recording, null),
          ),
        ),
      ),
    );
    // An interrupted take is a cancelled one.
    const exit = yield* Fiber.await(fiber);
    return yield* Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Effect.fail(new Cancelled())
      : exit;
  });

  /** The take from microphone startup to its answer. Completion belongs to
   *  Start, even when another project or view stops the recorder. */
  private readonly runTake = Effect.fn('HostDraftRequests.take')(function* (
    this: HostDraftRequests,
    take: Take,
  ) {
    const takeProgram: Effect.Effect<
      HostOutcome,
      Rejected,
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
          // sox exiting before Stop ends the take, a clean exit included:
          // the microphone is no longer recording. Cancel interrupts.
          yield* Effect.raceFirst(
            take.stopped.await,
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
      // A Cancel after Stop interrupts the upload.
      return yield* postStop;
    });
    // The take's warnings (an unexpected sox exit, the stale-take sweep)
    // stay on this channel.
    return yield* takeProgram.pipe(withLogChannel(CHANNEL));
  });

  /** Stop acknowledges its own request; the take transcribes. */
  private readonly stop = Effect.suspend(() => {
    const take = this.take;
    if (!take) return Effect.void;
    return Effect.andThen(
      SubscriptionRef.set(this.recording, null),
      take.stopped.open,
    );
  });
}
