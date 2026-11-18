// The upload stays a Node read stream: the SDK names the multipart file from
// the stream's path, and the endpoint reads the audio format from that name.
import { createReadStream } from 'node:fs';

// Third-party imports
import { Effect } from 'effect';
import OpenAI from 'openai';

// Local imports
import type { ModelError } from '../errors.js';
import { openaiFailure } from './openaiResponsesCodec.js';

/** OpenAI's speech-to-text model; no other provider serves the endpoint. */
const TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';

/**
 * The text of an audio file, from OpenAI's transcription endpoint with an
 * OpenAI key. Interrupting the effect aborts the upload; the SDK's own
 * retries are off, as on every other provider call.
 */
export function transcribeAudio(
  audioPath: string,
  credential: { readonly bearer: string; readonly endpoint: string },
): Effect.Effect<string, ModelError> {
  return Effect.tryPromise({
    try: async (signal) => {
      const client = new OpenAI({
        apiKey: credential.bearer,
        baseURL: credential.endpoint,
        maxRetries: 0,
      });
      const result = await client.audio.transcriptions.create(
        {
          file: createReadStream(audioPath),
          model: TRANSCRIPTION_MODEL,
          response_format: 'json',
        },
        { signal },
      );
      return result.text;
    },
    catch: openaiFailure,
  });
}
