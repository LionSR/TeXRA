import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { execa, type Subprocess } from 'execa';
import OpenAI from 'openai';

import type { ApiKeyRouteCredential } from '@agent/runtime/modelRoutes';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { createLog } from '@logger/logUtils';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { RelativeFS } from '@utils/files/relativeFS';
import { THREE_DAYS_MS } from '@utils/config/constants';
import { readConfig } from '@utils/config/configUtils';
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
 * `stopRecordingAndTranscribe` gives up waiting and reads the file anyway.
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

/** Resolve the sox executable command from config or auto-detection. */
function resolveSoxCommand(
  roots: WorkspaceRoots,
): ResolvedBinaryCommand | null {
  const configuredPath = readConfig<string>(
    roots.config,
    'texra.audio.soxPath',
  );
  if (configuredPath && AbsoluteFS.existsSync(configuredPath)) {
    return BinaryResolver.resolveOptionalCommand('sox', [], {
      resolvedPath: configuredPath,
    });
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
    await AbsoluteFS.ensureDir(directory);
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
 * Stop the current recording and transcribe it using OpenAI. `credential` is
 * the OpenAI route the caller resolved: the key read is an Effect program
 * now, and this function is a promise the host settles, so the credential
 * arrives as data rather than as a store this function would have to read
 * from. `roots` are the recording session's, and own the directory the
 * finished takes are swept from.
 */
export async function stopRecordingAndTranscribe(
  credential: ApiKeyRouteCredential,
  roots: WorkspaceRoots,
): Promise<{
  success: boolean;
  text: string;
  error?: string;
}> {
  try {
    if (!activeRecordingProcess || !activeRecordingPath) {
      return { success: false, text: '', error: 'No active recording to stop' };
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

    if (!AbsoluteFS.existsSync(recordingPath)) {
      return { success: false, text: '', error: 'Recording file not found' };
    }

    const stats = AbsoluteFS.statSync(recordingPath);
    if (stats.size === 0) {
      return { success: false, text: '', error: 'Recording file is empty' };
    }

    // The transcription endpoint is an OpenAI SDK operation the llm package
    // does not model, so the client is built here.
    const client = new OpenAI({
      apiKey: credential.apiKey,
      baseURL: credential.endpoint,
    });
    const result = await client.audio.transcriptions.create({
      file: AbsoluteFS.createReadStream(recordingPath),
      model: 'gpt-4o-transcribe',
      response_format: 'json',
    });

    // `RelativeFS` passes an absolute target through untouched, so the sweep
    // is rooted by the caller's storage root rather than by an ambient read.
    await RelativeFS.cleanupOldFiles(recordingsDir(roots), THREE_DAYS_MS);

    return { success: true, text: result.text };
  } catch (err) {
    const message = getSdkErrorMessage(err);
    log.error(`Error in stopRecordingAndTranscribe: ${message}`);
    resetRecordingState();
    return { success: false, text: '', error: message };
  }
}
