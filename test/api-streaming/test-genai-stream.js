import { GoogleGenAI } from '@google/genai';

// Set the API key directly or via environment variable
const apiKey = process.env.GEMINI_API_KEY || 'YOUR_API_KEY_HERE';
const ai = new GoogleGenAI({ apiKey });

async function run() {
  try {
    console.log('Starting stream...\n');
    
    const stream = await ai.models.generateContentStream({
      model: 'gemini-2.5-flash',
      contents: 'Count from 1 to 5. Each number on a new line.',
    });

    // Process the stream
    let lastChunk;
    for await (const chunk of stream) {
      lastChunk = chunk;
      // Check if chunk has text method or is text directly
      const text = typeof chunk.text === 'function' ? chunk.text() : chunk.text;
      process.stdout.write(text ?? chunk.toString());
    }

    console.log('\n\n--- Last Chunk Structure ---');
    console.log('Last chunk keys:', Object.keys(lastChunk || {}));
    console.log('Last chunk:', JSON.stringify(lastChunk, null, 2));
    
    // Check stream object properties
    console.log('\n--- Stream Object Properties ---');
    console.log('Stream keys:', Object.keys(stream));
    console.log('Stream.response exists?', 'response' in stream);
    
    // Try to get the final response after streaming
    const finalResponse = stream.response;
    
    console.log('\n\n--- Final Response Metadata ---');
    console.log('Final response exists?', finalResponse !== undefined);
    console.log('Usage Metadata:', JSON.stringify(finalResponse?.usageMetadata, null, 2));
    
    // Check for candidates and finish reason
    if (finalResponse?.candidates && finalResponse.candidates.length > 0) {
      const candidate = finalResponse.candidates[0];
      console.log('Finish Reason:', candidate.finishReason);
      console.log('Finish Message:', candidate.finishMessage);
      console.log('Safety Ratings:', JSON.stringify(candidate.safetyRatings, null, 2));
    }
    
    // Check for end turn reason or similar properties
    console.log('Model Version:', finalResponse?.modelVersion);
    console.log('Prompt Feedback:', JSON.stringify(finalResponse?.promptFeedback, null, 2));
    
    // Log the entire response structure for inspection
    console.log('\n--- Full Response Structure ---');
    console.log(JSON.stringify(finalResponse, null, 2));
    
  } catch (error) {
    console.error('Error:', error);
  }
}

run();