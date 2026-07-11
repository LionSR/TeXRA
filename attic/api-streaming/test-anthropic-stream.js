import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

import {
  logValidation,
  runStreamingAggregationTest,
} from './helpers/streamHarness.js';

dotenv.config();

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function testStreamingWithAggregation() {
  try {
    await runStreamingAggregationTest({
      title: 'Anthropic Streaming Test with Chunk Aggregation',
      createStream: () =>
        client.messages.create({
          model: 'claude-3-5-haiku-20241205',
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: 'Count from 1 to 5. Each number on a new line.',
            },
          ],
          stream: true,
        }),
      consumeStream: async (stream) => {
        const aggregatedResponse = {
          id: null,
          type: 'message',
          role: 'assistant',
          content: [],
          model: null,
          stop_reason: null,
          stop_sequence: null,
          usage: null,
        };

        let currentTextBlock = {
          type: 'text',
          text: '',
        };

        let chunkCount = 0;
        let messageStart = null;

        console.log('Streaming content:\n');

        for await (const event of stream) {
          chunkCount++;

          switch (event.type) {
            case 'message_start':
              messageStart = event.message;
              aggregatedResponse.id = messageStart.id;
              aggregatedResponse.model = messageStart.model;
              aggregatedResponse.role = messageStart.role;
              aggregatedResponse.usage = messageStart.usage;
              break;

            case 'content_block_start':
              if (event.content_block.type === 'text') {
                currentTextBlock = {
                  type: 'text',
                  text: '',
                };
              }
              break;

            case 'content_block_delta':
              if (event.delta.type === 'text_delta') {
                const text = event.delta.text;
                currentTextBlock.text += text;
                process.stdout.write(text);
              }
              break;

            case 'content_block_stop':
              if (currentTextBlock.text) {
                aggregatedResponse.content.push({ ...currentTextBlock });
              }
              break;

            case 'message_delta':
              if (event.delta.stop_reason) {
                aggregatedResponse.stop_reason = event.delta.stop_reason;
              }
              if (event.delta.stop_sequence) {
                aggregatedResponse.stop_sequence = event.delta.stop_sequence;
              }
              if (event.usage) {
                aggregatedResponse.usage = {
                  ...aggregatedResponse.usage,
                  ...event.usage,
                };
              }
              break;

            case 'message_stop':
              break;
          }
        }

        return { aggregated: aggregatedResponse, count: chunkCount };
      },
      createNonStream: () =>
        client.messages.create({
          model: 'claude-3-5-haiku-20241205',
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: 'Count from 1 to 5. Each number on a new line.',
            },
          ],
          stream: false,
        }),
      compare: (aggregatedResponse, nonStreamResponse) => {
        const aggregatedText = aggregatedResponse.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('');
        const nonStreamText = nonStreamResponse.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('');

        logValidation(
          'Content matches',
          aggregatedText.trim() === nonStreamText.trim(),
        );
        logValidation(
          'Both have stop_reason',
          !!aggregatedResponse.stop_reason && !!nonStreamResponse.stop_reason,
        );
        logValidation(
          'Both have usage data',
          !!aggregatedResponse.usage && !!nonStreamResponse.usage,
        );
      },
    });
  } catch (error) {
    console.error('Error:', error);
  }
}

async function testStreamToFinalMessage() {
  console.log('\n\n=== Using SDK finalMessage() Method ===\n');

  try {
    // Using the beta stream API which provides finalMessage()
    const stream = client.beta.messages.stream({
      model: 'claude-3-5-haiku-20241205',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: 'Write a haiku about programming.',
        },
      ],
    });

    // Display content as it streams
    console.log('Streaming content:\n');
    stream.on('text', (text) => {
      process.stdout.write(text);
    });

    // Get the final complete message using SDK method
    const finalMessage = await stream.finalMessage();

    console.log(
      '\n\nFinal message from finalMessage():',
      JSON.stringify(finalMessage, null, 2),
    );

    // Validate final message structure
    console.log('\n--- Final Message Validation ---');
    console.log('Has complete content:', finalMessage.content.length > 0);
    console.log('Has stop_reason:', !!finalMessage.stop_reason);
    console.log('Has usage data:', !!finalMessage.usage);
    console.log('Message type:', finalMessage.type);
    console.log('Message role:', finalMessage.role);
  } catch (error) {
    console.error('Error:', error);
  }
}

async function testStreamWithIteratorAndFinal() {
  console.log('\n\n=== Testing Different Stream Consumption Methods ===\n');

  try {
    // Test 1: Using beta.messages.stream with iteration
    console.log(
      'Test 1: Beta stream with async iteration then finalMessage()\n',
    );
    const stream1 = client.beta.messages.stream({
      model: 'claude-3-5-haiku-20241205',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: 'What is 2 + 2? Answer in one word.',
        },
      ],
    });

    // Process events manually
    for await (const event of stream1) {
      if (event.type === 'text') {
        process.stdout.write(event.text);
      }
    }

    // Can still get final message after iteration!
    const finalMessage1 = await stream1.finalMessage();
    console.log(
      '\n\nFinal message after iteration:',
      JSON.stringify(finalMessage1, null, 2),
    );

    // Test 2: Regular streaming API (no finalMessage available)
    console.log('\n\nTest 2: Regular stream API (no finalMessage method)\n');
    const stream2 = await client.messages.create({
      model: 'claude-3-5-haiku-20241205',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: 'What is 3 + 3? Answer in one word.',
        },
      ],
      stream: true,
    });

    for await (const event of stream2) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        process.stdout.write(event.delta.text);
      }
    }

    console.log(
      '\n\nNote: Regular stream API does not have finalMessage() method',
    );
  } catch (error) {
    console.error('Error:', error);
  }
}

async function testStreamWithBetaAPI() {
  console.log('\n\n=== Using Beta Stream API with finalMessage() ===\n');

  try {
    // Using the beta stream method directly
    const stream = client.beta.messages.stream({
      model: 'claude-3-5-haiku-20241205',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: 'Explain recursion in one sentence.',
        },
      ],
    });

    // Option 1: Use on() event handlers
    stream.on('text', (text) => {
      process.stdout.write(text);
    });

    // Wait for the stream to complete and get final message
    const finalMessage = await stream.finalMessage();

    console.log(
      '\n\nFinal message from beta.messages.stream():',
      JSON.stringify(finalMessage, null, 2),
    );

    // Validate the response
    console.log('\n--- Beta Stream Validation ---');
    console.log('Message ID:', finalMessage.id);
    console.log('Model:', finalMessage.model);
    console.log('Stop reason:', finalMessage.stop_reason);
    console.log('Token usage:', finalMessage.usage);
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run all tests
async function run() {
  await testStreamingWithAggregation();
  await testStreamToFinalMessage();
  await testStreamWithIteratorAndFinal();
  await testStreamWithBetaAPI();
}

run();
