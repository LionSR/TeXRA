import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

import {
  logValidation,
  runStreamingAggregationTest,
} from './helpers/streamHarness.js';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// OpenAI: Stream to user + get final response
async function testOpenAIStreamingBoth() {
  await runStreamingAggregationTest({
    title: 'OpenAI: Stream + Final Response',
    createStream: () =>
      openai.chat.completions.create({
        model: 'o1-mini',
        messages: [
          {
            role: 'user',
            content: 'Explain why the sky is blue in 2 sentences.',
          },
        ],
        stream: true,
        stream_options: { include_usage: true },
      }),
    consumeStream: async (stream) => {
      const aggregated = {
        content: '',
        reasoning: '',
        finalResponse: null,
      };
      let count = 0;

      console.log('Streaming to user:\n');

      for await (const chunk of stream) {
        count++;
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          aggregated.content += content;
          process.stdout.write(content);
        }

        const reasoning = chunk.choices[0]?.delta?.reasoning_content || '';
        if (reasoning) {
          aggregated.reasoning += reasoning;
          process.stdout.write(`[REASONING] ${reasoning}\n`);
        }
      }

      aggregated.finalResponse = await stream.finalChatCompletion();

      return { aggregated, count };
    },
    createNonStream: () =>
      openai.chat.completions.create({
        model: 'o1-mini',
        messages: [
          {
            role: 'user',
            content: 'Explain why the sky is blue in 2 sentences.',
          },
        ],
        stream: false,
      }),
    compare: (aggregated, nonStream) => {
      const streamedContent =
        aggregated.finalResponse?.choices[0]?.message?.content ?? '';
      const nonStreamContent = nonStream.choices[0]?.message?.content ?? '';
      logValidation(
        'Content matches non-stream',
        streamedContent.trim() === nonStreamContent.trim(),
      );
      logValidation('Reasoning captured', aggregated.reasoning.length > 0);
      logValidation('Usage present', Boolean(aggregated.finalResponse?.usage));
      logValidation(
        'Finish reason',
        aggregated.finalResponse?.choices[0]?.finish_reason ?? null,
      );
    },
  });
}

// Anthropic: Stream to user + get final response
async function testAnthropicStreamingBoth() {
  console.log('\n\n=== Anthropic: Stream + Final Response ===\n');

  // Must use beta.messages.stream for finalMessage()
  const stream = anthropic.beta.messages.stream({
    model: 'claude-3-5-haiku-20241205',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: 'Explain why water is wet in 2 sentences.',
      },
    ],
  });

  console.log('Streaming to user:\n');

  // Option 1: Use event handlers
  stream.on('text', (text) => {
    process.stdout.write(text); // Stream to user
  });

  // You can also handle other events
  stream.on('message_start', (message) => {
    console.log(`\n[Started message ${message.id}]\n`);
  });

  stream.on('message_stop', () => {
    console.log('\n[Message complete]');
  });

  // Wait for completion and get final message
  const finalMessage = await stream.finalMessage();

  console.log('\n--- Final Assembled Response ---');
  console.log(
    'Full content:',
    finalMessage.content.map((c) => c.text).join(''),
  );
  console.log('Usage:', finalMessage.usage);
  console.log('Stop reason:', finalMessage.stop_reason);

  return finalMessage; // Can use this for further processing
}

// Alternative Anthropic approach with manual iteration
async function testAnthropicManualIteration() {
  await runStreamingAggregationTest({
    title: 'Anthropic: Manual Iteration + Final Response',
    createStream: () =>
      anthropic.beta.messages.stream({
        model: 'claude-3-5-haiku-20241205',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: 'What is 2+2? Answer in one word.',
          },
        ],
      }),
    consumeStream: async (stream) => {
      const aggregated = {
        text: '',
        finalMessage: null,
      };
      let count = 0;

      for await (const event of stream) {
        count++;
        if (event.type === 'text') {
          aggregated.text += event.text;
          process.stdout.write(event.text);
        }
      }

      aggregated.finalMessage = await stream.finalMessage();
      console.log('\n\nFinal:', aggregated.finalMessage.content[0].text);

      return { aggregated, count };
    },
    createNonStream: () =>
      anthropic.messages.create({
        model: 'claude-3-5-haiku-20241205',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: 'What is 2+2? Answer in one word.',
          },
        ],
        stream: false,
      }),
    compare: (aggregated, nonStream) => {
      const streamedText = aggregated.finalMessage?.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
      const nonStreamText = nonStream.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');

      logValidation(
        'Content matches non-stream',
        streamedText.trim() === nonStreamText.trim(),
      );
      logValidation(
        'Stop reason',
        aggregated.finalMessage?.stop_reason ?? nonStream.stop_reason,
      );
    },
  });
}

// Practical example: Stream with processing
async function practicalExample() {
  console.log('\n\n=== Practical Example: Stream + Process + Store ===\n');

  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: 'List 3 programming languages with brief descriptions.',
      },
    ],
    stream: true,
    stream_options: { include_usage: true },
  });

  // Track streaming for user feedback
  let streamedChunks = [];

  console.log('User sees this in real-time:\n');
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    if (content) {
      process.stdout.write(content); // Real-time display
      streamedChunks.push(content); // Optional: track chunks
    }
  }

  // Get final response for database/logging/processing
  const finalResponse = await stream.finalChatCompletion();

  console.log('\n\n--- What gets saved to database ---');
  const dataToSave = {
    id: finalResponse.id,
    model: finalResponse.model,
    content: finalResponse.choices[0].message.content,
    usage: finalResponse.usage,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(dataToSave, null, 2));

  return dataToSave;
}

// Run all examples
async function run() {
  try {
    await testOpenAIStreamingBoth();
    await testAnthropicStreamingBoth();
    await testAnthropicManualIteration();
    await practicalExample();
  } catch (error) {
    console.error('Error:', error);
  }
}

run();
