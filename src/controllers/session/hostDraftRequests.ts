/** Shared draft operations and the process recorder's originating request. */
import * as path from 'node:path';

import { Data, Deferred, Effect, FileSystem, Option } from 'effect';
import { MODEL_CONFIGS } from 'llm-zoo';

import { resolveRouteCredential } from '@agent/runtime/modelRoutes';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { polishTextWithAI } from '@agent/runtime/textEnhancement';
import { createLog } from '@logger/logUtils';
import { AppState } from '@platform/interfaces';
import type { LanguageModel } from '@platform/languageModel';
import { Secrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { HostRequest } from '@shared/session/hostRequest';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import { Cancelled, Rejected } from '@shared/session/requestErrors';
import type { HostOutcome } from '@shared/session/sessionFrames';
import {
  killActiveRecording,
  recordingsDir,
  startRecording,
  stopRecording,
  transcribeRecording,
} from '@tools/media/audio';
import { THREE_DAYS_MS } from '@utils/config/constants';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { savePastedImageBase64 } from '@utils/files/pastedImageUtils';
import type { HttpClient } from 'effect/unstable/http';

const log = createLog('HostDraftRequests');

/**
 * Delete recordings older than three days under the session's recordings
 * directory. Never fails the transcription: every listing or unlink error is
 * warned with its cause, and one bad entry does not stop the rest of the sweep.
 */
function cleanupOldRecordings(
  roots: WorkspaceRoots,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const directory = recordingsDir(roots);
    const fs = yield* FileSystem.FileSystem;
    const cutoff = Date.now() - THREE_DAYS_MS;
    const names = yield* fs.readDirectory(directory).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          log.warn(`Skipped cleanup of ${directory}: ${toErrorMessage(error)}`);
          return [] as string[];
        }),
      ),
    );
    yield* Effect.forEach(
      names,
      (name) => {
        const filePath = path.join(directory, name);
        return fs.stat(filePath).pipe(
          Effect.flatMap((stats) => {
            // The sweep it replaces filtered on the provider's type bits,
            // where a symlink answers for its target and so counted as a file
            // when it pointed at one. The follow above does the same job: a
            // link to a file is swept by its target's age, a link to a
            // directory is not swept at all.
            if (stats.type !== 'File') return Effect.void;
            const mtime = Option.match(stats.mtime, {
              onNone: () => 0,
              onSome: (modified) => modified.getTime(),
            });
            return mtime <= cutoff ? fs.remove(filePath) : Effect.void;
          }),
          Effect.catch((error) =>
            Effect.sync(() => {
              log.warn(
                `Could not remove stale recording ${filePath}: ${toErrorMessage(error)}`,
              );
            }),
          ),
        );
      },
      { concurrency: 'unbounded', discard: true },
    );
  });
}

/**
 * A draft operation this controller drives faulted rather than reporting an
 * outcome. Every member below answers with a result object of its own —
 * "the microphone would not start", "transcription failed" — so reaching
 * here means the call itself threw.
 *
 * `savePastedImage` keeps its `Promise` shape deliberately: the write goes
 * through `StorageFS`'s ambient-rooted statics, and the three-day cleanup it
 * performs has no equivalent on the rooted `StorageFs` view yet, so moving it
 * is #12421's consumer work on `pastedImageUtils`, not a call-site change.
 */
class DraftOperationFailed extends Data.TaggedError('DraftOperationFailed')<{
  readonly member:
    | 'savePastedImage'
    | 'startRecording'
    | 'stopRecording'
    | 'transcribeRecording';
  readonly message: string;
  readonly cause: unknown;
}> {}

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

  /** Answer one draft request of `session`, arriving on `port`. The host
   *  that took the request runs this where it stands. */
  readonly handle = Effect.fn('HostDraftRequests.handle')(function* (
    this: HostDraftRequests,
    session: SessionHandle,
    request: DraftRequest,
    port: string,
  ): Effect.fn.Return<
    HostOutcome,
    unknown,
    | AppState
    | Secrets
    | FileSystem.FileSystem
    | LanguageModel
    | HttpClient.HttpClient
  > {
    switch (request.kind) {
      case 'polish': {
        // The helper model behind the polish is resolved against the process
        // stores; a host port takes no services, so they are read here.
        const stores = {
          secrets: yield* Secrets,
          globalState: yield* AppState,
        };
        const text = yield* polishTextWithAI(
          request.text,
          stores,
          session.roots,
        ).pipe(
          Effect.mapError((error) => new Rejected({ reason: error.message })),
        );
        return { kind: 'text', text };
      }
      case 'savePastedImage':
        return {
          kind: 'savedImage',
          fileName: yield* Effect.tryPromise({
            try: () => savePastedImageBase64(request.base64, request.fileName),
            catch: (cause) =>
              new DraftOperationFailed({
                member: 'savePastedImage',
                message: 'The pasted image could not be saved.',
                cause,
              }),
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
    const takeProgram: Effect.Effect<
      HostOutcome,
      unknown,
      Secrets | FileSystem.FileSystem
    > = Effect.gen(function* () {
      // Transcription binds its OpenAI credential against the process
      // secret store the host root provides.
      const secrets = yield* Secrets;
      // The recorder writes under the take's own session storage, so its
      // roots travel with the call instead of through a roots scope the
      // detached take fiber would have to stay inside.
      const started = yield* Effect.tryPromise({
        try: () => startRecording(take.session.roots),
        catch: (cause) =>
          new DraftOperationFailed({
            member: 'startRecording',
            message: 'The recorder could not be started.',
            cause,
          }),
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
      // The recorder is terminated before anything else is read: sox gets
      // SIGTERM and the module's recording state resets here, so a slow,
      // denied or failing credential read below cannot delay the kill or
      // leave the microphone running when the take is rejected.
      const stopped = yield* Effect.tryPromise({
        try: () => stopRecording(),
        catch: (cause) =>
          new DraftOperationFailed({
            member: 'stopRecording',
            message: 'The recorder could not be stopped.',
            cause,
          }),
      });
      const recordingPath = stopped.recordingPath;
      if (!stopped.success || recordingPath === undefined) {
        return yield* new Rejected({
          reason: stopped.error ?? 'The recording could not be stopped.',
        });
      }
      // The transcription endpoint is an OpenAI SDK operation the llm
      // package does not model, and the direct OpenAI route is deliberate:
      // `gpt-4o-transcribe` is an OpenAI-only endpoint model with no
      // OpenRouter route, so the global OpenRouter preference is not
      // applied to it. The take holds no session frame to enter — its
      // roots travel with each call — so the endpoint read runs in the
      // calling frame, and the resolved credential reaches the
      // transcription as data.
      const inCallingScope = <A>(read: () => A): A => read();
      const credential = yield* resolveRouteCredential(
        MODEL_CONFIGS['gpt4o'],
        false,
        secrets,
        inCallingScope,
      ).pipe(
        Effect.mapError((error) => new Rejected({ reason: error.message })),
      );
      const result = yield* Effect.tryPromise({
        try: () => transcribeRecording(recordingPath, credential),
        catch: (cause) =>
          new DraftOperationFailed({
            member: 'transcribeRecording',
            message: 'The recording could not be transcribed.',
            cause,
          }),
      });
      if (!result.success) {
        return yield* new Rejected({
          reason: result.error ?? 'Transcription failed.',
        });
      }
      // The sweep is rooted by the take's storage root, as data, rather than
      // by an ambient read of the calling fiber's roots.
      yield* cleanupOldRecordings(take.session.roots);
      return { kind: 'text', text: result.text };
    });
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
