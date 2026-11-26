/** Shared draft operations and the process recorder's originating request. */
import { Buffer } from 'node:buffer';

import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Latch,
  Option,
  Stream,
  SubscriptionRef,
} from 'effect';
import type { Scope } from 'effect';
import { MODEL_CONFIGS } from '@texra-ai/llm';
import { transcribeAudio } from '@texra-ai/llm/node';

import { type WorkspaceRoots } from '@texra-ai/worldline';
import { ownKeyCredential } from '@texra-ai/worldline/host';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import type { HostOutcome } from '@texra/shared/session/sessionFrames';
import { polishTextWithAI } from '@texra/controllers/session/draftPolish';
import {
  recordingsDir,
  startRecording,
  validateRecordingFile,
} from '@texra/controllers/session/audio';
import {
  savePastedImageBuffer,
  sweepStaleFiles,
  type PastedImageSaveFailed,
} from '@texra/utils/files/pastedImageUtils';
import {
  Secrets,
  withLogChannel,
  type StorageFs,
  AppState,
} from '@texra-ai/worldline/plugins';
import { Cancelled, Rejected } from '@texra-ai/worldline/schemas';
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

interface ActiveTake {
  readonly take: Take;
  readonly fiber: Fiber.Fiber<HostOutcome, Rejected>;
  readonly recording: Recording | null;
}

/** One instance per host process, shared by its session request handlers.
 *  The take runs in one fiber of the process's scope; `recording` is what
 *  every open project shows of it. */
export class HostDraftRequests {
  /** The recorder in the caller's scope: closing it interrupts a take
   *  still running and waits for sox to exit. */
  static readonly make = Effect.gen(function* () {
    return new HostDraftRequests(
      yield* SubscriptionRef.make<ActiveTake | undefined>(undefined),
      yield* Effect.scope,
    );
  });

  /** The take recording now and where it is going; null once it stopped. */
  readonly recording: Stream.Stream<Recording | null>;
  private readonly scope: Scope.Scope;
  private readonly active: SubscriptionRef.SubscriptionRef<
    ActiveTake | undefined
  >;
  private constructor(
    active: SubscriptionRef.SubscriptionRef<ActiveTake | undefined>,
    scope: Scope.Scope,
  ) {
    this.active = active;
    this.recording = SubscriptionRef.changes(active).pipe(
      Stream.map((state) => state?.recording ?? null),
      Stream.changes,
    );
    this.scope = scope;
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
    // Read under the same lock as Start, then interrupt that specific fiber
    // outside the lock so its finalizer can release the take.
    return SubscriptionRef.modifySome(this.active, (state) => [
      state?.take.roots === roots &&
      (port === undefined || state.take.port === port)
        ? state.fiber
        : undefined,
      Option.none(),
    ]).pipe(
      Effect.flatMap((fiber) =>
        fiber === undefined ? Effect.void : Fiber.interrupt(fiber),
      ),
    );
  }

  private readonly start = Effect.fn('HostDraftRequests.start')(function* (
    this: HostDraftRequests,
    roots: WorkspaceRoots,
    port: string,
    target: string,
  ) {
    const stopped = yield* Latch.make(false);
    const take: Take = { roots, port, stopped };
    const fiber = yield* SubscriptionRef.modifyEffect(this.active, (active) =>
      Effect.gen({ self: this }, function* () {
        if (active !== undefined) {
          return yield* new Rejected({
            reason: 'A recording is already in progress.',
          });
        }
        // Publish the take and its process-owned fiber together. A request
        // can exit while the process still needs to wait for sox.
        const fiber = yield* Effect.forkIn(
          this.runTake(take).pipe(
            Effect.ensuring(
              SubscriptionRef.updateSome(this.active, (current) =>
                current?.take === take ? Option.some(undefined) : Option.none(),
              ),
            ),
          ),
          this.scope,
          { startImmediately: true },
        );
        // A closed process scope returns an already interrupted fiber.
        if (fiber.pollUnsafe() !== undefined)
          return [fiber, undefined] as const;
        return [
          fiber,
          { take, fiber, recording: { session: roots.storage, target } },
        ] as const;
      }),
    ).pipe(Effect.uninterruptible);
    // An interrupted take is a cancelled one.
    const exit = yield* Fiber.await(fiber);
    return yield* Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Effect.fail(new Cancelled())
      : exit;
  });

  /** The take from microphone startup to its answer. Completion belongs to
   *  Start, even when another project or view stops the recorder. */
  private readonly runTake = Effect.fn('HostDraftRequests.take')(function* ({
    roots,
    stopped,
  }: Take): Effect.fn.Return<
    HostOutcome,
    Rejected,
    Secrets | FileSystem.FileSystem | ChildProcessSpawner
  > {
    const reject = (error: { message: string }) =>
      new Rejected({ reason: error.message });
    // Closing this scope stops sox and waits for its file before transcription.
    const captured = yield* Effect.scoped(
      Effect.gen(function* () {
        const recorder = yield* startRecording(roots).pipe(
          Effect.mapError(reject),
        );
        const unexpectedExit = recorder.handle.exitCode.pipe(
          Effect.match({
            onFailure: (error) => error.message,
            onSuccess: (code) => `sox exited with code ${code}`,
          }),
          Effect.flatMap((reason) =>
            Effect.fail(
              new Rejected({
                reason: `Recording stopped unexpectedly: ${reason}`,
              }),
            ),
          ),
          Effect.tapError((error) => Effect.logWarning(error.reason)),
        );
        yield* Effect.raceFirst(stopped.await, unexpectedExit);
        return recorder.path;
      }),
    );
    const recordingPath = yield* validateRecordingFile(captured).pipe(
      Effect.mapError(reject),
    );
    const credential = yield* ownKeyCredential(
      roots,
      MODEL_CONFIGS['openai/gpt-4o-2024-11-20'],
    ).pipe(Effect.mapError(reject));
    const text = yield* transcribeAudio(recordingPath, credential).pipe(
      Effect.tapError((error) =>
        Effect.logError(`Transcription failed: ${error.message}`),
      ),
      Effect.mapError(reject),
    );
    yield* sweepStaleFiles(yield* FileSystem.FileSystem, recordingsDir(roots));
    return { kind: 'text', text };
  }, withLogChannel(CHANNEL));

  /** Stop acknowledges its own request; the take transcribes. */
  private readonly stop = Effect.suspend(() =>
    SubscriptionRef.modifySome(this.active, (state) =>
      state === undefined || state.recording === null
        ? [undefined, Option.none()]
        : [state.take.stopped, Option.some({ ...state, recording: null })],
    ).pipe(
      Effect.flatMap((stopped) => stopped?.open ?? Effect.void),
      Effect.uninterruptible,
    ),
  );
}
