// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { execa, type Subprocess } from 'execa';

// Local imports - log
import { ModelHandlerOpenAI } from '@agent/modelHandlers/modelHandlerOpenAI';
import { getSdkErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { MODEL_CONFIGS } from '@model/ModelRegistry';
import { AbsoluteFS, StorageFS } from '@utils/files';
import { sleep } from '@utils/core';
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

/**
 * Start recording audio from the microphone.
 * @param context Extension context for storage path access
 * @returns Promise with recording path or error
 */
export async function startRecording(
  context: vscode.ExtensionContext,
): Promise<{ success: boolean; recordingPath?: string; error?: string }> {
  try {
    // Check if already recording
    if (activeRecordingProcess) {
      return {
        success: false,
        error: 'Recording already in progress',
      };
    }

    // Determine sox path from configuration or auto-detection
    const configuredPath = getConfig<string>('texra.audio.soxPath', '');
    const soxPath =
      configuredPath && AbsoluteFS.existsSync(configuredPath)
        ? configuredPath
        : findToolInCommonPaths('sox');
    logger.info(CHANNEL, `Sox path found: ${soxPath}`);

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
    // Initialize StorageFS with context if not already done
    StorageFS.initialize(context);
    await StorageFS.ensureDir(RECORDINGS_DIR);
    const relativePath = path.join(RECORDINGS_DIR, `record_${Date.now()}.wav`);
    const absPath = StorageFS.fullPath(relativePath);

    // Start recording without duration limit
    const soxArgs = [
      '--default-device', // Use default input device
      '--no-show-progress', // Don't show progress
      '--rate',
      '16000', // Sample rate
      '--channels',
      '1', // Mono
      '--encoding',
      'signed-integer',
      '--bits',
      '16', // 16-bit
      '--type',
      'wav', // Output format
      absPath, // Output file
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

    // Handle the subprocess promise to prevent unhandled rejection
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
        activeRecordingProcess = null;
        activeRecordingPath = null;
      })
      .catch((error) => {
        // This should not happen with reject: false, but handle it just in case
        logger.error(CHANNEL, `Sox process error: ${error.message}`);
        activeRecordingProcess = null;
        activeRecordingPath = null;
      });

    // Capture stderr for debugging
    activeRecordingProcess.stderr?.on('data', (data: Buffer) => {
      logger.debug(CHANNEL, `Sox stderr: ${data.toString()}`);
    });

    return { success: true, recordingPath: absPath };
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in startRecording: ${getSdkErrorMessage(err)}`,
    );
    activeRecordingProcess = null;
    activeRecordingPath = null;
    return { success: false, error: getSdkErrorMessage(err) };
  }
}

/**
 * Stop the current recording and transcribe it.
 * @param context Extension context for storage path access
 * @returns Promise with transcribed text or error
 */
export async function stopRecordingAndTranscribe(
  context: vscode.ExtensionContext,
): Promise<{ success: boolean; text: string; error?: string }> {
  try {
    if (!activeRecordingProcess || !activeRecordingPath) {
      return {
        success: false,
        text: '',
        error: 'No active recording to stop',
      };
    }

    const recordingPath = activeRecordingPath;

    // Stop the recording process
    activeRecordingProcess.kill('SIGTERM');
    activeRecordingProcess = null;
    activeRecordingPath = null;

    // Wait a bit for the file to be properly written
    await sleep(500);

    // Check if the file exists and has content
    if (!AbsoluteFS.existsSync(recordingPath)) {
      return {
        success: false,
        text: '',
        error: 'Recording file not found',
      };
    }

    const stats = AbsoluteFS.statSync(recordingPath);
    if (stats.size === 0) {
      return {
        success: false,
        text: '',
        error: 'Recording file is empty',
      };
    }

    // Transcribe the audio using model handler for proxy support
    const handler = new ModelHandlerOpenAI(MODEL_CONFIGS['gpt4o']);
    const client = await handler.getClient();
    const result = await client.audio.transcriptions.create({
      file: AbsoluteFS.createReadStream(recordingPath),
      model: 'gpt-4o-transcribe',
      response_format: 'json',
    });

    // Clean up old recordings
    // Initialize StorageFS with context if not already done
    StorageFS.initialize(context);
    await StorageFS.cleanupOldFiles(RECORDINGS_DIR, THREE_DAYS_MS);

    return { success: true, text: result.text };
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in stopRecordingAndTranscribe: ${getSdkErrorMessage(err)}`,
    );
    activeRecordingProcess = null;
    activeRecordingPath = null;
    return { success: false, text: '', error: getSdkErrorMessage(err) };
  }
}
