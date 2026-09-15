import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Effect, FileSystem, Option } from 'effect';
import { execa, type Subprocess } from 'execa';
import OpenAI from 'openai';

import type { ApiKeyRouteCredential } from '@agent/runtime/modelRoutes';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { createLog } from '@logger/logUtils';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { THREE_DAYS_MS } from '@utils/config/constants';
import { readConfig } from '@utils/config/configUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  BinaryResolver,
  type ResolvedBinaryCommand,
} from '@utils/system/binaryResolver';
import { extendEnvPath } from '@utils/system/platformPaths';

const log = createLog('AudioUtils');

const RECORDINGS_DIR = 'recordings';

/**
 * Where this session's recordings live. The roots arrive as data from the
 * caller that owns the session, so a recording writes under that session's
 * storage root without the module entering (or reading) an ambient roots
 * scope — the desktop holds one session per open paper.
 */
function recordingsDir(roots: WorkspaceRoots): string {
  return path.join(roots.storage, RECORDINGS_DIR);
}

/**
 * Upper bound on how long a SIGTERM'd sox may take to flush and exit before
 * `stopRecording` gives up waiting and reads the file anyway.
 */
const SOX_SHUTDOWN_TIMEOUT_MS = 5000;

// Store active recording process
let activeRecordingProcess: Subprocess | null = null;
let activeRecordingPath: string | null = null;

/** Reset recording state to idle. */
function resetRecordingState(): void {
  activeRecordingProcess = null;
  activeRecordingPath = null;
}

/**
 * Delete recordings older than `maxAgeMs` under `directory`.
 *
 * Never throws. The sweep runs after a transcription has already succeeded,
 * so a take another process is still holding, or one that vanished between
 * the listing and the stat, must not destroy that result: every failure is
 * warned with its cause, and one bad entry does not stop the rest of the
 * sweep. A listing that fails is warned and skipped for the same reason.
 *
 * The directory arrives as data from the caller that owns the session's roots
 * — the absolute form the old `RelativeFS.cleanupOldFiles` resolved to — so
 * the sweep no longer reads an ambient storage root.
 */
export function cleanupOldRecordings(
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

/** Resolve the sox executable command from config or auto-detection. */
function resolveSoxCommand(
  roots: WorkspaceRoots,
): ResolvedBinaryCommand | null {
  const configuredPath = readConfig<string>(
    roots.config,
    'texra.audio.soxPath',
  );
  if (configuredPath) {
    // `AbsoluteFS.existsSync` validated the path before probing it, so a
    // non-absolute `soxPath` threw "Path must be absolute: ..." and the
    // recording failed loudly instead of quietly auto-detecting whatever
    // `sox` is on PATH. A relative path still resolves against the process
    // cwd, never the workspace, so it cannot be the configured binary.
    if (!path.isAbsolute(configuredPath)) {
      throw new Error(`Path must be absolute: ${configuredPath}`);
    }
    if (existsSync(configuredPath)) {
      return BinaryResolver.resolveOptionalCommand('sox', [], {
        resolvedPath: configuredPath,
      });
    }
  }
  return BinaryResolver.resolveOptionalCommand('sox');
}

/** Start recording audio from the microphone under `roots`' storage. */
export async function startRecording(roots: WorkspaceRoots): Promise<{
  success: boolean;
  recordingPath?: string;
  error?: string;
}> {
  try {
    if (activeRecordingProcess) {
      return { success: false, error: 'Recording already in progress' };
    }

    const soxCommand = resolveSoxCommand(roots);
    if (!soxCommand) {
      return {
        success: false,
        error: 'Sox is required for audio recording. Please install it first.',
      };
    }

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
        env: { ...process.env, PATH: extendEnvPath() },
        reject: false,
      },
    );

    activeRecordingProcess = subprocess;
    activeRecordingPath = absPath;

    subprocess
      .then((result) => {
        // On Windows, kill('SIGTERM') acts as force-kill and result.signal
        // may be 'SIGTERM' or null depending on Node version.  Also treat
        // SIGKILL as intentional since it can come from the force-kill path.
        const intentional =
          result.signal === 'SIGTERM' || result.signal === 'SIGKILL';
        if (intentional) {
          log.info('Recording stopped intentionally');
        } else if (result.exitCode !== 0) {
          log.error(`Sox process exited with code ${result.exitCode}`);
        } else {
          log.info('Recording process completed successfully');
        }
        if (activeRecordingProcess === subprocess) resetRecordingState();
      })
      .catch((error) => {
        log.error(`Sox process error: ${error.message}`);
        if (activeRecordingProcess === subprocess) resetRecordingState();
      });

    subprocess.stderr?.on('data', (data: Buffer) => {
      log.debug(`Sox stderr: ${data.toString()}`);
    });

    return { success: true, recordingPath: absPath };
  } catch (err) {
    const message = getSdkErrorMessage(err);
    log.error(`Error in startRecording: ${message}`);
    resetRecordingState();
    return { success: false, error: message };
  }
}

/** Forcibly terminate the active recording process if one exists. */
export function killActiveRecording(): void {
  if (activeRecordingProcess) {
    activeRecordingProcess.kill('SIGTERM');
    resetRecordingState();
  }
}

/**
 * Stop the current recording and hand back the file it captured.
 *
 * This is the termination step and it waits on nothing else: sox gets
 * SIGTERM and this module's recording state resets before the caller resolves
 * the transcription credential, so a slow, denied or failing keychain read
 * can never leave the microphone running. The captured file is validated
 * here too, because "what the take captured" is the answer this step owes its
 * caller.
 */
export async function stopRecording(): Promise<{
  success: boolean;
  recordingPath?: string;
  error?: string;
}> {
  try {
    if (!activeRecordingProcess || !activeRecordingPath) {
      return { success: false, error: 'No active recording to stop' };
    }

    const recordingPath = activeRecordingPath;
    const recording = activeRecordingProcess;
    recording.kill('SIGTERM');
    resetRecordingState();

    // Await the process this module already holds rather than guessing how
    // long sox needs to flush. `execa` was started with `reject: false`, so
    // this settles on exit instead of throwing. The bounded race is a
    // backstop for a wedged sox — without it a process that ignores SIGTERM
    // would hang the tool, which the old fixed sleep could not do.
    await Promise.race([
      recording.catch(() => undefined),
      delay(SOX_SHUTDOWN_TIMEOUT_MS),
    ]);

    if (!existsSync(recordingPath)) {
      return { success: false, error: 'Recording file not found' };
    }

    const stats = statSync(recordingPath);
    if (stats.size === 0) {
      return { success: false, error: 'Recording file is empty' };
    }

    return { success: true, recordingPath };
  } catch (err) {
    const message = getSdkErrorMessage(err);
    log.error(`Error in stopRecording: ${message}`);
    resetRecordingState();
    return { success: false, error: message };
  }
}

/**
 * Transcribe a stopped recording with OpenAI. `credential` is the OpenAI
 * route the caller resolved: the key read is an Effect program now, and this
 * function is a promise the host settles, so the credential arrives as data
 * rather than as a store this function would have to read from. The recorder
 * is already terminated by the time this runs — it is {@link stopRecording}
 * that owns the microphone. Stale takes under the session's recordings
 * directory are swept by {@link cleanupOldRecordings} at that same host
 * boundary after a successful transcription.
 */
export async function transcribeRecording(
  recordingPath: string,
  credential: ApiKeyRouteCredential,
): Promise<{
  success: boolean;
  text: string;
  error?: string;
}> {
  try {
    // The transcription endpoint is an OpenAI SDK operation the llm package
    // does not model, so the client is built here.
    const client = new OpenAI({
      apiKey: credential.apiKey,
      baseURL: credential.endpoint,
    });
    const result = await client.audio.transcriptions.create({
      file: createReadStream(recordingPath),
      model: 'gpt-4o-transcribe',
      response_format: 'json',
    });

    return { success: true, text: result.text };
  } catch (err) {
    const message = getSdkErrorMessage(err);
    log.error(`Error in transcribeRecording: ${message}`);
    return { success: false, text: '', error: message };
  }
}
