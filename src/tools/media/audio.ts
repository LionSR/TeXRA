// The transcription upload stays a Node read stream: the OpenAI SDK names the
// multipart file from the stream's path, and the endpoint reads the audio
// format from that name.
import { createReadStream } from 'node:fs';
import * as path from 'node:path';

import {
  Data,
  Duration,
  Effect,
  FileSystem,
  PlatformError,
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
 * Start recording audio from the microphone under `roots`' storage: sox lives
 * exactly as long as the caller's scope, whose close is the whole stop:
 * SIGTERM so sox flushes the file, SIGKILL after SOX_SHUTDOWN_TIMEOUT_MS for
 * a wedged sox, and a join on its exit, so the file is complete once the
 * scope has closed. Answers with the file the take is captured into and the
 * process handle, whose exit the caller watches.
 */
export function startRecording(
  roots: WorkspaceRoots,
): Effect.Effect<
  { readonly path: string; readonly handle: ChildProcessHandle },
  AudioRecorderError,
  FileSystem.FileSystem | ChildProcessSpawner | Scope.Scope
> {
  return Effect.gen(function* () {
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
    ).pipe(recorderFailure('startRecording'));
    // sox's stderr, line by line, for as long as it runs; the caller's scope
    // ends it with the process.
    yield* Effect.forkScoped(
      handle.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Effect.logDebug(`Sox stderr: ${line}`)),
        Effect.catch((error: PlatformError.PlatformError) =>
          Effect.logDebug(`Sox stderr ended early: ${error.reason._tag}`),
        ),
        withLogChannel(CHANNEL),
      ),
    );
    return { path: absPath, handle };
  });
}

/**
 * Validate the file a stopped take captured. The recorder's scope has closed
 * by the time this runs, so sox has exited and the file is complete; the
 * caller stops the microphone before resolving the transcription credential,
 * so a slow, denied or failing keychain read can never leave it running.
 */
export function stopRecording(
  recordingPath: string,
): Effect.Effect<string, AudioRecorderError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const size = yield* fs.stat(recordingPath).pipe(
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
    return recordingPath;
  });
}

/**
 * Transcribe a stopped recording with OpenAI. `credential` is the OpenAI
 * route the caller resolved, so it arrives as data rather than as a store
 * this function would have to read from. The recorder is already terminated
 * by the time this runs. Interrupting the call aborts the upload. Stale
 * takes under the session's recordings directory are swept by the host take
 * fiber after a successful transcription.
 */
export function transcribeRecording(
  recordingPath: string,
  credential: ApiKeyRouteCredential,
): Effect.Effect<string, AudioRecorderError> {
  return Effect.tryPromise({
    // The transcription endpoint is an OpenAI SDK operation the llm package
    // does not model, so the client is built here — the one foreign call this
    // module wraps.
    try: async (signal) => {
      const client = new OpenAI({
        apiKey: credential.apiKey,
        baseURL: credential.endpoint,
      });
      const result = await client.audio.transcriptions.create(
        {
          file: createReadStream(recordingPath),
          model: 'gpt-4o-transcribe',
          response_format: 'json',
        },
        { signal },
      );
      return result.text;
    },
    catch: ensureError,
  }).pipe(recorderFailure('transcribeRecording'));
}
