// Standard library imports
import * as fs from 'fs';
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import OpenAI from 'openai';
import record from 'node-record-lpcm16';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utils
import { getApiKey } from '@frontend/secrets';
import {
  createStorageDirectory,
  storagePathToAbsolute,
  createStoragePath,
  cleanupStorageDirectory,
} from '@utils/files/workspaceStorageUtils';
import { getSdkErrorMessage } from '@utils/sdkErrorUtils';

const CHANNEL = 'AudioUtils';
logger.initialize(CHANNEL);

const RECORDINGS_DIR = 'recordings';

/**
 * Record audio from the microphone and transcribe it using OpenAI.
 * @param context Extension context for storage path access
 * @param durationSec Recording duration in seconds
 */
export async function recordAndTranscribe(
  context: vscode.ExtensionContext,
  durationSec = 5,
): Promise<{ success: boolean; text: string; error?: string }> {
  try {
    await createStorageDirectory(context, RECORDINGS_DIR);
    const relativePath = path.join(RECORDINGS_DIR, `record_${Date.now()}.wav`);
    const absPath = storagePathToAbsolute(
      createStoragePath(relativePath),
      context,
    );

    await new Promise<void>((resolve, reject) => {
      const fileStream = fs.createWriteStream(absPath, { encoding: 'binary' });
      const rec = record.record({ sampleRate: 16000, threshold: 0 });
      rec.stream().on('error', reject).pipe(fileStream);
      setTimeout(() => {
        rec.stop();
        fileStream.end();
      }, durationSec * 1000);
      fileStream.on('finish', resolve);
    });

    const apiKey = await getApiKey('openai');
    const client = new OpenAI({ apiKey });
    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(absPath),
      model: 'gpt-4o-transcribe',
      response_format: 'json',
    });

    await cleanupStorageDirectory(
      context,
      RECORDINGS_DIR,
      3 * 24 * 60 * 60 * 1000,
    );

    return { success: true, text: result.text };
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in recordAndTranscribe: ${getSdkErrorMessage(err)}`,
    );
    return { success: false, text: '', error: getSdkErrorMessage(err) };
  }
}
