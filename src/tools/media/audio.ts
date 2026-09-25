// The transcription upload stays a Node read stream: the OpenAI SDK names the
// multipart file from the stream's path, and the endpoint reads the audio
// format from that name.
import { createReadStream } from 'node:fs';
import * as path from 'node:path';

import {
  Cause,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  PlatformError,
  Ref,
  Scope,
  Stream,
} from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import OpenAI from 'openai';

import type { ApiKeyRouteCredential } from '@agent/runtime/modelRoutes';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { withLogChannel } from '@logger/effectLog';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  resolveOptionalCommand,
  type ResolvedBinaryCommand,
} from '@utils/system/binaryResolver';
import { withExtendedPath } from '@utils/system/platformPaths';
import { ensureError } from '@utils/errors/errorMessage';
import { absentReason } from '@utils/files/fsEntryExists';
import type {
  ChildProcessHandle,
  ChildProcessSpawner,
} from 'effect/unstable/process/ChildProcessSpawner';

const CHANNEL = 'AudioUtils';

const RECORDINGS_DIR = 'recordings';

/**
 * Where this session's recordings live. The roots arrive as data from the
 * caller that owns the session, so a recording writes under that session's
 * storage root without the module entering (or reading) an ambient roots
 * scope — the desktop holds one session per open paper.
 */
export function recordingsDir(roots: WorkspaceRoots): string {
  return path.join(roots.storage, RECORDINGS_DIR);
}

/**
 * Why a recorder operation could not answer. `message` is the wording the
 * caller shows the person — "Sox is required…", "Recording file is empty" —
 * so a refusal reaches the draft request already worded and the caller never
 * re-mints one.
 */
class AudioRecorderError extends Data.TaggedError('AudioRecorderError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The failure a foreign call of `operation` carries back, logged once here
 *  where the operation is named. A filesystem failure is worded by its errno
 *  text. */
const recorderFailure =
  (operation: string) =>
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, AudioRecorderError, R> =>
    Effect.catch(self, (cause) => {
      const message = getSdkErrorMessage(
        cause instanceof PlatformError.PlatformError
          ? (cause.reason.cause ?? cause)
          : cause,
      );
      return Effect.logError(`Error in ${operation}: ${message}`).pipe(
        withLogChannel(CHANNEL),
        Effect.andThen(Effect.fail(new AudioRecorderError({ message, cause }))),
      );
    });

/**
 * How long a SIGTERM'd sox may take to flush and exit before the scope's
 * release escalates to SIGKILL.
 */
const SOX_SHUTDOWN_TIMEOUT_MS = 5000;

/** A take in progress: sox lives exactly as long as `scope`. */
interface ActiveRecording {
  readonly scope: Scope.Closeable;
  readonly handle: ChildProcessHandle;
  readonly path: string;
}

/**
 * The one recorder of this process. Every entry point — a take's start and
 * stop, sox exiting on its own, and the host shutdown hook — claims or
 * releases the microphone through this cell, so the single-recorder invariant
 * holds across all of them.
 */
const activeRecording = Ref.makeUnsafe<ActiveRecording | null>(null);

/** Resolve the sox executable command from config or auto-detection. */
const resolveSoxCommand = Effect.fnUntraced(function* (
  roots: WorkspaceRoots,
): Effect.fn.Return<
  ResolvedBinaryCommand | null,
  AudioRecorderError,
  FileSystem.FileSystem | ChildProcessSpawner
> {
  const configuredPath = roots.config.get<string>('texra.audio.soxPath');
  if (configuredPath) {
    // The path is validated before being probed, so a non-absolute
    // `soxPath` fails "Path must be absolute: ..." and the recording
    // fails loudly instead of quietly auto-detecting whatever
    // `sox` is on PATH. A relative path still resolves against the process
    // cwd, never the workspace, so it cannot be the configured binary.
    if (!path.isAbsolute(configuredPath)) {
      return yield* new AudioRecorderError({
        message: `Path must be absolute: ${configuredPath}`,
      });
    }
    // A configured binary that is missing fails loudly too: silently
    // recording with whatever `sox` is on PATH is not what was configured.
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(configuredPath).pipe(
      Effect.catchIf(absentReason, () => Effect.succeed(false)),
      recorderFailure('startRecording'),
    );
    if (!exists) {
      return yield* new AudioRecorderError({
        message: `Configured sox path does not exist: ${configuredPath}`,
      });
    }
    return yield* resolveOptionalCommand('sox', [], {
      resolvedPath: configuredPath,
    });
  }
  return yield* resolveOptionalCommand('sox');
});

/**
 * Log how sox ended and release the recorder if this take still holds it.
 * Runs detached from whoever started the take: sox outlives the call, and
 * its own exit is what frees the microphone when no Stop ever arrives. A take
 * that Stop or the shutdown hook already released was ended on purpose; the
 * cell, not the exit signal, says which.
 */
function watchRecorderExit(recording: ActiveRecording): Effect.Effect<void> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(recording.handle.exitCode);
    const owned = (yield* Ref.get(activeRecording)) === recording;
    if (Exit.isSuccess(exit) && exit.value === 0) {
      yield* Effect.logInfo('Recording process completed successfully');
    } else if (!owned) {
      yield* Effect.logInfo('Recording stopped intentionally');
    } else if (Exit.isSuccess(exit)) {
      yield* Effect.logError(`Sox process exited with code ${exit.value}`);
    } else {
      yield* Effect.logError(
        `Sox process error: ${getSdkErrorMessage(Cause.squash(exit.cause))}`,
      );
    }
    yield* Ref.update(activeRecording, (current) =>
      current === recording ? null : current,
    );
    yield* Scope.close(recording.scope, Exit.void);
  }).pipe(withLogChannel(CHANNEL));
}

/**
 * Start recording audio from the microphone under `roots`' storage and answer
 * with the file the take is captured into. The recorder is claimed only once
 * every step that can fail has succeeded, so no failure path has state to undo.
 */
export function startRecording(
  roots: WorkspaceRoots,
): Effect.Effect<
  string,
  AudioRecorderError,
  FileSystem.FileSystem | ChildProcessSpawner
> {
  return Effect.gen(function* () {
    if ((yield* Ref.get(activeRecording)) !== null) {
      return yield* new AudioRecorderError({
        message: 'Recording already in progress',
      });
    }

    // Resolve sox and create the directory, then spawn the recorder. Nothing
    // in either step has claimed the microphone yet, so a failure leaves no
    // state to undo.
    const soxCommand = yield* resolveSoxCommand(roots);
    if (!soxCommand) {
      return yield* new AudioRecorderError({
        message:
          'Sox is required for audio recording. Please install it first.',
      });
    }
    const directory = recordingsDir(roots);
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .makeDirectory(directory, { recursive: true })
      .pipe(recorderFailure('startRecording'));
    const absPath = path.join(directory, `record_${Date.now()}.wav`);
    const soxArgs = [
      '--default-device',
      '--no-show-progress',
      '--rate',
      '16000',
      '--channels',
      '1',
      '--encoding',
      'signed-integer',
      '--bits',
      '16',
      '--type',
      'wav',
      absPath,
    ];
    yield* Effect.logInfo(
      `Starting audio recording with sox: ${soxCommand.resolvedPath} ${soxArgs.join(' ')}`,
    ).pipe(withLogChannel(CHANNEL));

    const scope = yield* Scope.make();
    const handle = yield* ChildProcess.make(
      soxCommand.command,
      [...soxCommand.args, ...soxArgs],
      {
        env: withExtendedPath(process.env),
        extendEnv: false,
        stdin: 'ignore',
        stdout: 'ignore',
        detached: false,
        forceKillAfter: Duration.millis(SOX_SHUTDOWN_TIMEOUT_MS),
      },
    ).pipe(
      Scope.provide(scope),
      recorderFailure('startRecording'),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    );
    const started: ActiveRecording = { scope, handle, path: absPath };

    yield* Ref.set(activeRecording, started);
    yield* Effect.forkDetach(watchRecorderExit(started));
    // sox's stderr, line by line, for as long as it runs; the take's scope
    // ends it with the process.
    yield* Effect.forkIn(
      handle.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Effect.logDebug(`Sox stderr: ${line}`)),
        Effect.catch((error: PlatformError.PlatformError) =>
          Effect.logDebug(`Sox stderr ended early: ${error.reason._tag}`),
        ),
        withLogChannel(CHANNEL),
      ),
      scope,
    );
    return started.path;
  });
}

/** Forcibly terminate the active recording process if one exists. */
export function killActiveRecording(): Effect.Effect<void> {
  return Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRecording, null);
    if (active) yield* Scope.close(active.scope, Exit.void);
  });
}

/**
 * Stop the current recording and hand back the file it captured.
 *
 * This is the termination step and it waits on nothing else: the recorder is
 * released and sox is stopped before the caller resolves the transcription
 * credential, so a slow, denied or failing keychain read can never leave the
 * microphone running. The captured file is validated here too, because "what
 * the take captured" is the answer this step owes its caller.
 */
export function stopRecording(): Effect.Effect<
  string,
  AudioRecorderError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRecording, null);
    if (!active) {
      return yield* new AudioRecorderError({
        message: 'No active recording to stop',
      });
    }

    // Closing the take's scope is the whole stop: SIGTERM so sox flushes the
    // file, SIGKILL after SOX_SHUTDOWN_TIMEOUT_MS for a wedged sox, and a
    // join on its exit, so the file is complete before it is read.
    yield* Scope.close(active.scope, Exit.void);

    const fs = yield* FileSystem.FileSystem;
    const size = yield* fs.stat(active.path).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.catchIf(absentReason, () => Effect.succeed(null)),
      recorderFailure('stopRecording'),
    );
    if (size === null) {
      return yield* new AudioRecorderError({
        message: 'Recording file not found',
      });
    }
    if (size === 0) {
      return yield* new AudioRecorderError({
        message: 'Recording file is empty',
      });
    }
    return active.path;
  });
}

/**
 * Transcribe a stopped recording with OpenAI. `credential` is the OpenAI
 * route the caller resolved, so it arrives as data rather than as a store
 * this function would have to read from. The recorder is already terminated
 * by the time this runs — it is {@link stopRecording} that owns the
 * microphone. Stale takes under the session's recordings directory are swept
 * by the host take fiber after a successful transcription.
 */
export function transcribeRecording(
  recordingPath: string,
  credential: ApiKeyRouteCredential,
): Effect.Effect<string, AudioRecorderError> {
  return Effect.tryPromise({
    // The transcription endpoint is an OpenAI SDK operation the llm package
    // does not model, so the client is built here — the one foreign call this
    // module wraps.
    try: async () => {
      const client = new OpenAI({
        apiKey: credential.apiKey,
        baseURL: credential.endpoint,
      });
      const result = await client.audio.transcriptions.create({
        file: createReadStream(recordingPath),
        model: 'gpt-4o-transcribe',
        response_format: 'json',
      });
      return result.text;
    },
    catch: ensureError,
  }).pipe(recorderFailure('transcribeRecording'));
}
