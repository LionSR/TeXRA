import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

import { Data, Effect, Ref } from 'effect';
import { execa, type Subprocess } from 'execa';
import OpenAI from 'openai';

import type { ApiKeyRouteCredential } from '@agent/runtime/modelRoutes';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { withLogChannel } from '@logger/effectLog';
import { createLog } from '@logger/logUtils';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  resolveOptionalCommand,
  type ResolvedBinaryCommand,
} from '@utils/system/binaryResolver';
import { withExtendedPath } from '@utils/system/platformPaths';
import { ensureError } from '@utils/errors/errorMessage';

const CHANNEL = 'AudioUtils';
const log = createLog(CHANNEL);

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
 *  where the operation is named. */
const recorderFailure =
  (operation: string) =>
  <A, E>(self: Effect.Effect<A, E>): Effect.Effect<A, AudioRecorderError> =>
    Effect.catch(self, (cause) => {
      const message = getSdkErrorMessage(cause);
      return Effect.logError(`Error in ${operation}: ${message}`).pipe(
        withLogChannel(CHANNEL),
        Effect.andThen(Effect.fail(new AudioRecorderError({ message, cause }))),
      );
    });

/**
 * Upper bound on how long a SIGTERM'd sox may take to flush and exit before
 * `stopRecording` gives up waiting and reads the file anyway.
 */
const SOX_SHUTDOWN_TIMEOUT_MS = 5000;

interface ActiveRecording {
  readonly process: Subprocess;
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
function resolveSoxCommand(
  roots: WorkspaceRoots,
): ResolvedBinaryCommand | null {
  const configuredPath = roots.config.get<string>('texra.audio.soxPath');
  if (configuredPath) {
    // The path is validated before being probed, so a non-absolute
    // `soxPath` throws "Path must be absolute: ..." and the recording
    // fails loudly instead of quietly auto-detecting whatever
    // `sox` is on PATH. A relative path still resolves against the process
    // cwd, never the workspace, so it cannot be the configured binary.
    if (!path.isAbsolute(configuredPath)) {
      throw new Error(`Path must be absolute: ${configuredPath}`);
    }
    if (existsSync(configuredPath)) {
      return resolveOptionalCommand('sox', [], {
        resolvedPath: configuredPath,
      });
    }
  }
  return resolveOptionalCommand('sox');
}

/**
 * Log how sox ended and release the recorder if this subprocess still holds
 * it. Runs detached from whoever started the take: sox outlives the call, and
 * its own exit is what frees the microphone when no Stop ever arrives.
 */
function watchRecorderExit(subprocess: Subprocess): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => subprocess,
    catch: ensureError,
  }).pipe(
    Effect.matchEffect({
      onSuccess: (result) => {
        // On Windows, kill('SIGTERM') acts as force-kill and result.signal
        // may be 'SIGTERM' or null depending on Node version.  Also treat
        // SIGKILL as intentional since it can come from the force-kill path.
        const intentional =
          result.signal === 'SIGTERM' || result.signal === 'SIGKILL';
        if (intentional) {
          return Effect.logInfo('Recording stopped intentionally');
        }
        if (result.exitCode !== 0) {
          return Effect.logError(
            `Sox process exited with code ${result.exitCode}`,
          );
        }
        return Effect.logInfo('Recording process completed successfully');
      },
      onFailure: (cause) =>
        Effect.logError(`Sox process error: ${getSdkErrorMessage(cause)}`),
    }),
    withLogChannel(CHANNEL),
    Effect.andThen(
      Ref.update(activeRecording, (current) =>
        current?.process === subprocess ? null : current,
      ),
    ),
  );
}

/**
 * Start recording audio from the microphone under `roots`' storage and answer
 * with the file the take is captured into. The recorder is claimed only once
 * every step that can fail has succeeded, so no failure path has state to undo.
 */
export function startRecording(
  roots: WorkspaceRoots,
): Effect.Effect<string, AudioRecorderError> {
  return Effect.gen(function* () {
    if ((yield* Ref.get(activeRecording)) !== null) {
      return yield* new AudioRecorderError({
        message: 'Recording already in progress',
      });
    }

    // One foreign region: resolve sox, create the directory, spawn the
    // recorder. Nothing in it has claimed the microphone yet, so a throw
    // leaves no state to undo.
    const started = yield* Effect.tryPromise({
      try: async (): Promise<ActiveRecording | null> => {
        const soxCommand = resolveSoxCommand(roots);
        if (!soxCommand) return null;

        const directory = recordingsDir(roots);
        await mkdir(directory, { recursive: true });
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
        log.info(
          `Starting audio recording with sox: ${soxCommand.resolvedPath} ${soxArgs.join(' ')}`,
        );

        const subprocess = execa(
          soxCommand.command,
          [...soxCommand.args, ...soxArgs],
          {
            env: withExtendedPath(process.env),
            reject: false,
          },
        );
        subprocess.stderr?.on('data', (data: Buffer) => {
          log.debug(`Sox stderr: ${data.toString()}`);
        });
        return { process: subprocess, path: absPath };
      },
      catch: (cause) => cause,
    }).pipe(recorderFailure('startRecording'));
    if (!started) {
      return yield* new AudioRecorderError({
        message:
          'Sox is required for audio recording. Please install it first.',
      });
    }

    yield* Ref.set(activeRecording, started);
    yield* Effect.forkDetach(watchRecorderExit(started.process));
    return started.path;
  });
}

/** Forcibly terminate the active recording process if one exists. */
export function killActiveRecording(): Effect.Effect<void> {
  return Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRecording, null);
    if (active) active.process.kill('SIGTERM');
  });
}

/**
 * Stop the current recording and hand back the file it captured.
 *
 * This is the termination step and it waits on nothing else: the recorder is
 * released and sox gets SIGTERM before the caller resolves the transcription
 * credential, so a slow, denied or failing keychain read can never leave the
 * microphone running. The captured file is validated here too, because "what
 * the take captured" is the answer this step owes its caller.
 */
export function stopRecording(): Effect.Effect<string, AudioRecorderError> {
  return Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRecording, null);
    if (!active) {
      return yield* new AudioRecorderError({
        message: 'No active recording to stop',
      });
    }

    yield* Effect.try({
      try: () => active.process.kill('SIGTERM'),
      catch: (cause) => cause,
    }).pipe(recorderFailure('stopRecording'));

    // Await the process this module already holds rather than guessing how
    // long sox needs to flush. `execa` was started with `reject: false`, so
    // this settles on exit instead of throwing. The bounded wait is a
    // backstop for a wedged sox — without it a process that ignores SIGTERM
    // would hang the tool, which the old fixed sleep could not do.
    yield* Effect.tryPromise({
      try: () => active.process,
      catch: ensureError,
    }).pipe(Effect.ignore, Effect.timeoutOption(SOX_SHUTDOWN_TIMEOUT_MS));

    const size = yield* Effect.try({
      try: () => (existsSync(active.path) ? statSync(active.path).size : null),
      catch: (cause) => cause,
    }).pipe(recorderFailure('stopRecording'));
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
    catch: (cause) => cause,
  }).pipe(recorderFailure('transcribeRecording'));
}
