import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// OpenAI: Stream to user + get final response
async function testOpenAIStreamingBoth() {
  console.log('=== OpenAI: Stream + Final Response ===\n');
  
  const stream = await openai.chat.completions.create({
    model: 'o1-mini',
    messages: [
      {
        role: 'user',
        content: 'Explain why the sky is blue in 2 sentences.',
      },
    ],
    stream: true,
    stream_options: { include_usage: true },
  });

  console.log('Streaming to user:\n');
  
  // Process chunks for real-time display
  for await (const chunk of stream) {
    // Stream content to user
    const content = chunk.choices[0]?.delta?.content || '';
    if (content) {
      process.stdout.write(content); // This would be sent to user in real app
    }
    
    // For o1 models, also stream reasoning
    const reasoning = chunk.choices[0]?.delta?.reasoning_content || '';
    if (reasoning) {
      process.stdout.write(`[REASONING] ${reasoning}\n`);
    }
  }
  
  // After streaming completes, get the final assembled response
  const finalResponse = await stream.finalChatCompletion();
  
  console.log('\n\n--- Final Assembled Response ---');
  console.log('Full content:', finalResponse.choices[0].message.content);
  console.log('Usage:', finalResponse.usage);
  console.log('Finish reason:', finalResponse.choices[0].finish_reason);
  
  return finalResponse; // Can use this for further processing
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
  console.log('Full content:', finalMessage.content.map(c => c.text).join(''));
  console.log('Usage:', finalMessage.usage);
  console.log('Stop reason:', finalMessage.stop_reason);
  
  return finalMessage; // Can use this for further processing
}

// Alternative Anthropic approach with manual iteration
async function testAnthropicManualIteration() {
  console.log('\n\n=== Anthropic: Manual Iteration + Final Response ===\n');
  
  const stream = anthropic.beta.messages.stream({
    model: 'claude-3-5-haiku-20241205',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: 'What is 2+2? Answer in one word.',
      },
    ],
  });

  // Manually iterate (instead of event handlers)
  for await (const event of stream) {
    if (event.type === 'text') {
      process.stdout.write(event.text); // Stream to user
    }
    // Handle other event types as needed
  }
  
  // Still get the final message!
  const finalMessage = await stream.finalMessage();
  console.log('\n\nFinal:', finalMessage.content[0].text);
  
  return finalMessage;
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