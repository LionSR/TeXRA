import OpenAI from 'openai';
import dotenv from 'dotenv';

import {
  logValidation,
  runStreamingAggregationTest,
} from './helpers/streamHarness.js';

dotenv.config();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function testStreamingWithAggregation() {
  try {
    await runStreamingAggregationTest({
      title: 'OpenAI Streaming Test with Chunk Aggregation',
      createStream: () =>
        client.chat.completions.create({
          model: 'gpt-4o-mini',
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
        const aggregatedResponse = {
          id: null,
          object: 'chat.completion',
          created: null,
          model: null,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '',
              },
              finish_reason: null,
            },
          ],
          usage: null,
        };

        let chunkCount = 0;
        console.log('Streaming content:\n');

        for await (const chunk of stream) {
          chunkCount++;

          if (!aggregatedResponse.id && chunk.id) {
            aggregatedResponse.id = chunk.id;
            aggregatedResponse.created = chunk.created;
            aggregatedResponse.model = chunk.model;
          }

          const content = chunk.choices[0]?.delta?.content || '';
          if (content) {
            aggregatedResponse.choices[0].message.content += content;
            process.stdout.write(content);
          }

          if (chunk.choices[0]?.finish_reason) {
            aggregatedResponse.choices[0].finish_reason =
              chunk.choices[0].finish_reason;
          }

          if (chunk.usage) {
            aggregatedResponse.usage = chunk.usage;
          }
        }

        return { aggregated: aggregatedResponse, count: chunkCount };
      },
      createNonStream: () =>
        client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'user',
              content: 'Count from 1 to 5. Each number on a new line.',
            },
          ],
          stream: false,
        }),
      compare: (aggregatedResponse, nonStreamResponse) => {
        logValidation(
          'Content matches',
          aggregatedResponse.choices[0].message.content.trim() ===
            nonStreamResponse.choices[0].message.content.trim(),
        );
        logValidation(
          'Both have finish_reason',
          !!aggregatedResponse.choices[0].finish_reason &&
            !!nonStreamResponse.choices[0].finish_reason,
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

async function testStreamToFinalObject() {
  console.log('\n\n=== Using SDK finalChatCompletion() Method ===\n');

  try {
    const stream = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: 'Write a haiku about programming.',
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });

    // Process stream and collect content
    console.log('Streaming content:\n');
    let fullContent = '';

    // Use the stream's event emitter to process chunks
    stream.on('chunk', (chunk) => {
      const content = chunk.choices[0]?.delta?.content || '';
      fullContent += content;
      process.stdout.write(content);
    });

    // Wait for stream to complete and get final response
    const finalResponse = await stream.finalChatCompletion();

    console.log(
      '\n\nFinal response from finalChatCompletion():',
      JSON.stringify(finalResponse, null, 2),
    );

    // Validate final response structure
    console.log('\n--- Final Response Validation ---');
    console.log(
      'Has complete content:',
      !!finalResponse.choices[0]?.message?.content,
    );
    console.log(
      'Has finish_reason:',
      !!finalResponse.choices[0]?.finish_reason,
    );
    console.log('Has usage data:', !!finalResponse.usage);
    console.log('Response type:', finalResponse.object);
    console.log(
      'Content matches streamed:',
      finalResponse.choices[0]?.message?.content === fullContent,
    );
  } catch (error) {
    console.error('Error:', error);
  }
}

async function testStreamWithIteratorHelper() {
  console.log(
    '\n\n=== Alternative: Proper Usage of finalChatCompletion() ===\n',
  );

  try {
    // Test 1: Using event handlers + finalChatCompletion
    console.log('Test 1: Event handlers approach\n');
    const stream1 = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: 'What is 2 + 2? Answer in one word.',
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });

    // Setup event handler
    stream1.on('chunk', (chunk) => {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) process.stdout.write(content);
    });

    // Get final response (this waits for stream to complete)
    const finalResponse1 = await stream1.finalChatCompletion();
    console.log(
      '\n\nFinal response (event approach):',
      JSON.stringify(finalResponse1, null, 2),
    );

    // Test 2: Direct iteration then trying finalChatCompletion (should fail)
    console.log('\n\nTest 2: After full iteration (expected to fail)\n');
    const stream2 = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: 'What is 3 + 3? Answer in one word.',
        },
      ],
      stream: true,
    });

    // Fully consume the stream
    for await (const chunk of stream2) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) process.stdout.write(content);
    }

    try {
      // This should work since finalChatCompletion waits for done()
      const finalResponse2 = await stream2.finalChatCompletion();
      console.log(
        '\n\nSurprisingly, final response still works:',
        JSON.stringify(finalResponse2, null, 2),
      );
    } catch (err) {
      console.log('\n\nError getting final response:', err.message);
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run all tests
async function run() {
  await testStreamingWithAggregation();
  await testStreamToFinalObject();
  await testStreamWithIteratorHelper();
}

run();
