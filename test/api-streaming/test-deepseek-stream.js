import OpenAI from 'openai';

// DeepSeek uses OpenAI-compatible API
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/v1',
});

async function run() {
  try {
    console.log('Starting DeepSeek stream...\n');

    const stream = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'user',
          content: 'Count from 1 to 5. Each number on a new line.',
        },
      ],
      stream: true,
      stream_options: { include_usage: true }, // Request usage info in stream
    });

    let lastChunk;
    let fullContent = '';

    // Process the stream
    for await (const chunk of stream) {
      lastChunk = chunk;
      const content = chunk.choices[0]?.delta?.content || '';
      fullContent += content;
      process.stdout.write(content);

      // Check if this is the final chunk with usage data
      if (chunk.usage) {
        console.log('\n\n--- Usage data received in chunk ---');
        console.log('Usage:', JSON.stringify(chunk.usage, null, 2));
      }
    }

    console.log('\n\n--- Last Chunk Structure ---');
    console.log('Last chunk keys:', Object.keys(lastChunk || {}));
    console.log('Last chunk:', JSON.stringify(lastChunk, null, 2));

    // Check finish reason from last chunk
    if (lastChunk?.choices?.[0]) {
      const choice = lastChunk.choices[0];
      console.log('\n--- Finish Information ---');
      console.log('Finish reason:', choice.finish_reason);
      console.log('Stop reason:', choice.stop_reason);
    }

    // Try the non-streaming approach for comparison
    console.log('\n\n--- Non-streaming comparison ---');
    const nonStreamResponse = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'user',
          content: 'Count from 1 to 5. Each number on a new line.',
        },
      ],
      stream: false,
    });

    console.log(
      'Non-stream usage:',
      JSON.stringify(nonStreamResponse.usage, null, 2),
    );
    console.log(
      'Non-stream finish_reason:',
      nonStreamResponse.choices[0]?.finish_reason,
    );
  } catch (error) {
    console.error('Error:', error);
  }
}

run();
