import * as path from 'node:path';

import { execa, type Subprocess } from 'execa';
import { MODEL_CONFIGS } from 'llm-zoo';

import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { createLog } from '@logger/logUtils';
import { delay } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { StorageFS } from '@utils/files/storageFS';
import { THREE_DAYS_MS } from '@utils/config/constants';
import { getConfig } from '@utils/config/configUtils';
import {
  BinaryResolver,
  type ResolvedBinaryCommand,
} from '@utils/system/binaryResolver';
import { checkToolInstalled } from '@utils/system/toolUtils';
import { extendEnvPath } from '@utils/system/platformPaths';

const log = createLog('AudioUtils');

const RECORDINGS_DIR = 'recordings';

// Store active recording process
let activeRecordingProcess: Subprocess | null = null;
let activeRecordingPath: string | null = null;

/** Reset recording state to idle. */
function resetRecordingState(): void {
  activeRecordingProcess = null;
  activeRecordingPath = null;
}

/** Resolve the sox executable command from config or auto-detection. */
function resolveSoxCommand(): ResolvedBinaryCommand | null {
  const configuredPath = getConfig<string>('texra.audio.soxPath', '');
  if (configuredPath && AbsoluteFS.existsSync(configuredPath)) {
    return BinaryResolver.resolveOptionalCommand('sox', [], {
      resolvedPath: configuredPath,
    });
  }
  return BinaryResolver.resolveOptionalCommand('sox');
}

/** Start recording audio from the microphone. */
export async function startRecording(): Promise<{
  success: boolean;
  recordingPath?: string;
  error?: string;
}> {
  try {
    if (activeRecordingProcess) {
      return { success: false, error: 'Recording already in progress' };
    }

    const soxCommand = resolveSoxCommand();
    if (!(await checkToolInstalled('sox', false))) {
      if (!soxCommand) {
        return {
          success: false,
          error:
            'Sox is required for audio recording. Please install it first.',
        };
      }
      log.warn(`Sox check failed but found at: ${soxCommand.resolvedPath}`);
    }

    await StorageFS.ensureDir(RECORDINGS_DIR);
    const relativePath = path.join(RECORDINGS_DIR, `record_${Date.now()}.wav`);
    const absPath = StorageFS.fullPath(relativePath);

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
      `Starting audio recording with sox: ${soxCommand?.resolvedPath ?? 'sox'} ${soxArgs.join(' ')}`,
    );

    const subprocess = execa(
      soxCommand?.command ?? 'sox',
      [...(soxCommand?.args ?? []), ...soxArgs],
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
        resetRecordingState();
      })
      .catch((error) => {
        log.error(`Sox process error: ${error.message}`);
        resetRecordingState();
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

/** Stop the current recording and transcribe it using OpenAI. */
export async function stopRecordingAndTranscribe(): Promise<{
  success: boolean;
  text: string;
  error?: string;
}> {
  try {
    if (!activeRecordingProcess || !activeRecordingPath) {
      return { success: false, text: '', error: 'No active recording to stop' };
    }

    const recordingPath = activeRecordingPath;
    activeRecordingProcess.kill('SIGTERM');
    resetRecordingState();

    // Wait for file to be written
    await delay(500);

    if (!AbsoluteFS.existsSync(recordingPath)) {
      return { success: false, text: '', error: 'Recording file not found' };
    }

    const stats = AbsoluteFS.statSync(recordingPath);
    if (stats.size === 0) {
      return { success: false, text: '', error: 'Recording file is empty' };
    }

    const handler = new ModelHandlerOpenAI(MODEL_CONFIGS['gpt4o']);
    const client = await handler.getClient();
    const result = await client.audio.transcriptions.create({
      file: AbsoluteFS.createReadStream(recordingPath),
      model: 'gpt-4o-transcribe',
      response_format: 'json',
    });

    await StorageFS.cleanupOldFiles(RECORDINGS_DIR, THREE_DAYS_MS);

    return { success: true, text: result.text };
  } catch (err) {
    const message = getSdkErrorMessage(err);
    log.error(`Error in stopRecordingAndTranscribe: ${message}`);
    resetRecordingState();
    return { success: false, text: '', error: message };
  }
}
