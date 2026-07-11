// Third-party imports
import OpenAI from 'openai';

// Local imports - helpers
import {
  logValidation,
  runStreamingAggregationTest,
} from './helpers/streamHarness.js';

// DeepSeek uses OpenAI-compatible API
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/v1',
});

async function run() {
  try {
    await runStreamingAggregationTest({
      title: 'DeepSeek Streaming Test with Chunk Aggregation',
      createStream: () =>
        client.chat.completions.create({
          model: 'deepseek-chat',
          messages: [
            {
              role: 'user',
              content: 'Count from 1 to 5. Each number on a new line.',
            },
          ],
          stream: true,
          stream_options: { include_usage: true },
        }),
      consumeStream: async (stream) => {
        const aggregated = {
          content: '',
          lastChunk: null,
          usage: null,
          finishReason: null,
        };
        let count = 0;

        console.log('Streaming content:\n');

        for await (const chunk of stream) {
          count++;
          aggregated.lastChunk = chunk;

          const content = chunk.choices[0]?.delta?.content || '';
          aggregated.content += content;
          process.stdout.write(content);

          if (chunk.choices[0]?.finish_reason) {
            aggregated.finishReason = chunk.choices[0].finish_reason;
          }

          if (chunk.usage) {
            aggregated.usage = chunk.usage;
          }
        }

        return { aggregated, count };
      },
      createNonStream: () =>
        client.chat.completions.create({
          model: 'deepseek-chat',
          messages: [
            {
              role: 'user',
              content: 'Count from 1 to 5. Each number on a new line.',
            },
          ],
          stream: false,
        }),
      compare: (aggregated, nonStreamResponse) => {
        logValidation('Stream produced usage data', !!aggregated.usage);
        if (aggregated.usage && nonStreamResponse.usage) {
          logValidation(
            'Usage totals match',
            JSON.stringify(aggregated.usage) ===
              JSON.stringify(nonStreamResponse.usage),
          );
        }

        logValidation(
          'Finish reason matches',
          aggregated.finishReason ===
            nonStreamResponse.choices[0]?.finish_reason,
        );
      },
    });
  } catch (error) {
    console.error('Error:', error);
  }
}

run();
