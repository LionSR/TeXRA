// Third-party imports
import { GoogleGenAI } from '@google/genai';

// Local imports - helpers
import {
  logValidation,
  runStreamingAggregationTest,
} from './helpers/streamHarness.js';

// Set the API key directly or via environment variable
const apiKey = process.env.GEMINI_API_KEY || 'YOUR_API_KEY_HERE';
const ai = new GoogleGenAI({ apiKey });

async function run() {
  try {
    await runStreamingAggregationTest({
      title: 'Gemini Streaming Test with Chunk Aggregation',
      createStream: () =>
        ai.models.generateContentStream({
          model: 'gemini-2.5-flash',
          contents: 'Count from 1 to 5. Each number on a new line.',
        }),
      consumeStream: async (stream) => {
        const aggregated = {
          text: '',
          lastChunk: null,
          finalResponse: undefined,
          streamKeys: Object.keys(stream),
        };
        let count = 0;

        console.log('Streaming content:\n');

        for await (const chunk of stream) {
          count++;
          aggregated.lastChunk = chunk;
          const text =
            typeof chunk.text === 'function' ? chunk.text() : chunk.text;
          aggregated.text += text ?? chunk.toString();
          process.stdout.write(text ?? chunk.toString());
        }

        aggregated.finalResponse = stream.response;

        return { aggregated, count };
      },
      createNonStream: () =>
        ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: 'Count from 1 to 5. Each number on a new line.',
        }),
      compare: (aggregated, nonStreamResponse) => {
        const nonStreamText =
          typeof nonStreamResponse.response?.text === 'function'
            ? nonStreamResponse.response.text()
            : (nonStreamResponse.response?.text ?? '');

        logValidation(
          'Stream captured text',
          aggregated.text.trim().length > 0,
        );
        logValidation(
          'Content matches non-stream',
          aggregated.text.trim() === nonStreamText.trim(),
        );
        logValidation(
          'Final response exists',
          aggregated.finalResponse !== undefined,
        );
        const finishReason =
          aggregated.finalResponse?.candidates?.[0]?.finishReason;
        logValidation('Finish reason present', Boolean(finishReason));
      },
    });
  } catch (error) {
    console.error('Error:', error);
  }
}

run();
