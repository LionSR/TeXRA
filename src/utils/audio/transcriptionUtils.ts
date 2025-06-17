import OpenAI, { toFile } from 'openai';
import * as vscode from 'vscode';

import { getApiKey } from '@frontend/secrets';
import * as logger from '@logger/logUtils';
import { formatProviderError } from '../sdkErrorUtils';

const CHANNEL = 'audioTranscription';
logger.initialize(CHANNEL);

/**
 * Transcribe an audio buffer using OpenAI's transcription API.
 * @param audio The audio data to transcribe.
 * @param mimeType The MIME type of the audio.
 * @returns The transcribed text if successful.
 */
export async function transcribeAudio(
  audio: Buffer,
  mimeType: string,
): Promise<string | undefined> {
  try {
    const apiKey = await getApiKey('openai');
    const client = new OpenAI({ apiKey });
    const file = await toFile(audio, 'recording.webm', { type: mimeType });
    const result = await client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'text',
    });
    return result;
  } catch (err) {
    const message = formatProviderError('Audio transcription failed', err);
    logger.error(CHANNEL, message);
    vscode.window.showErrorMessage(message);
    return undefined;
  }
}
