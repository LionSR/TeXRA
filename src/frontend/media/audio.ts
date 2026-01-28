// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { execa, type Subprocess } from 'execa';

// Local imports - log
import { MODEL_CONFIGS } from 'llm-zoo';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/modelHandlerOpenAI';
import { getSdkErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { AbsoluteFS, StorageFS } from '@utils/files';
import { delay } from '@utils/core';
import { THREE_DAYS_MS } from '@utils/config';
import { getConfig } from '@utils/config/configUtils';
import { checkToolInstalled } from '@utils/system/toolUtils';
import {
  extendEnvPath,
  findToolInCommonPaths,
} from '@utils/system/platformPaths';

const CHANNEL = 'AudioUtils';
logger.initialize(CHANNEL);

const RECORDINGS_DIR = 'recordings';

// Store active recording process
let activeRecordingProcess: Subprocess | null = null;
let activeRecordingPath: string | null = null;

/** Reset recording state to idle. */
function resetRecordingState(): void {
  activeRecordingProcess = null;
  activeRecordingPath = null;
}

/** Resolve the sox executable path from config or auto-detection. */
function resolveSoxPath(): string | null {
  const configuredPath = getConfig<string>('texra.audio.soxPath', '');
  if (configuredPath && AbsoluteFS.existsSync(configuredPath)) {
    return configuredPath;
  }
  return findToolInCommonPaths('sox');
}

/** Start recording audio from the microphone. */
export async function startRecording(
  context: vscode.ExtensionContext,
): Promise<{ success: boolean; recordingPath?: string; error?: string }> {
  try {
    if (activeRecordingProcess) {
      return { success: false, error: 'Recording already in progress' };
    }

    const soxPath = resolveSoxPath();
    const soxInstalled = await checkToolInstalled('sox', false);

    if (!soxInstalled && !soxPath) {
      return {
        success: false,
        error: 'Sox is required for audio recording. Please install it first.',
      };
    }
    if (!soxInstalled && soxPath) {
      logger.warn(CHANNEL, `Sox check failed but found at: ${soxPath}`);
    }

    StorageFS.initialize(context);
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

    logger.info(
      CHANNEL,
      `Starting audio recording with sox: ${soxPath} ${soxArgs.join(' ')}`,
    );

    const subprocess = execa(soxPath || 'sox', soxArgs, {
      env: { ...process.env, PATH: extendEnvPath() },
      reject: false,
    });

    activeRecordingProcess = subprocess;
    activeRecordingPath = absPath;

    subprocess
      .then((result) => {
        if (result.signal === 'SIGTERM') {
          logger.info(CHANNEL, `Recording stopped intentionally`);
        } else if (result.exitCode !== 0) {
          logger.error(
            CHANNEL,
            `Sox process exited with code ${result.exitCode}`,
          );
        } else {
          logger.info(CHANNEL, `Recording process completed successfully`);
        }
        resetRecordingState();
      })
      .catch((error) => {
        logger.error(CHANNEL, `Sox process error: ${error.message}`);
        resetRecordingState();
      });

    subprocess.stderr?.on('data', (data: Buffer) => {
      logger.debug(CHANNEL, `Sox stderr: ${data.toString()}`);
    });

    return { success: true, recordingPath: absPath };
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in startRecording: ${getSdkErrorMessage(err)}`,
    );
    resetRecordingState();
    return { success: false, error: getSdkErrorMessage(err) };
  }
}

/** Stop the current recording and transcribe it using OpenAI. */
export async function stopRecordingAndTranscribe(
  context: vscode.ExtensionContext,
): Promise<{ success: boolean; text: string; error?: string }> {
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

    StorageFS.initialize(context);
    await StorageFS.cleanupOldFiles(RECORDINGS_DIR, THREE_DAYS_MS);

    return { success: true, text: result.text };
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in stopRecordingAndTranscribe: ${getSdkErrorMessage(err)}`,
    );
    resetRecordingState();
    return { success: false, text: '', error: getSdkErrorMessage(err) };
  }
}
