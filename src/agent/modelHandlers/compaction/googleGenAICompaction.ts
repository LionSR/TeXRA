/**
 * Google GenAI-specific compaction implementation.
 * Uses the Google GenAI SDK's native message format for summarization.
 */

import {
  GoogleGenAI,
  Content,
  Part,
  createPartFromText,
  createUserContent,
} from '@google/genai';

import type { SummarizationResult } from './types';
import { DEFAULT_SUMMARY_PROMPT, SUMMARY_TAG } from './compactionPrompt';
import { extractTextFromTag } from '@utils/text/xmlExtraction';

/**
 * Performs context summarization using the Google GenAI API.
 *
 * @param client - GoogleGenAI SDK client
 * @param messages - Current conversation messages (Content array)
 * @param systemPrompt - System prompt to use
 * @param compactionModel - Model to use for summarization
 * @param summaryPrompt - Prompt to use for summarization (defaults to DEFAULT_SUMMARY_PROMPT)
 * @returns Promise resolving to the summarization result
 */
export async function compactGoogleGenAI(
  client: GoogleGenAI,
  messages: Content[],
  systemPrompt: string,
  compactionModel: string,
  summaryPrompt: string = DEFAULT_SUMMARY_PROMPT,
): Promise<SummarizationResult> {
  // Remove pending function_call parts from last model message
  const cleanedMessages = cleanMessagesForCompaction(messages);

  // Create the summary request message
  const summaryUserMessage = createUserContent([
    createPartFromText(summaryPrompt),
  ]);

  // Use chat API for multi-turn context
  const chat = client.chats.create({
    model: compactionModel,
    config: {
      systemInstruction: systemPrompt,
    },
    history: cleanedMessages,
  });

  // Send the summary request
  const response = await chat.sendMessage({
    message: summaryUserMessage,
  });

  // Extract text from response
  const rawSummary = response.text ?? '';

  // Extract summary from tags if present, otherwise use raw response
  const summary = extractTextFromTag(rawSummary, SUMMARY_TAG) || rawSummary;

  return {
    summary,
    inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

/**
 * Cleans messages for compaction by removing pending function_call parts from the last model message.
 */
function cleanMessagesForCompaction(messages: Content[]): Content[] {
  if (messages.length === 0) {
    return messages;
  }

  const cleaned = [...messages];
  const lastMsg = cleaned[cleaned.length - 1];

  // Only process if last message is from model
  if (lastMsg?.role !== 'model') {
    return cleaned;
  }

  // Filter out function_call parts
  const nonFunctionParts = lastMsg.parts?.filter(
    (part: Part) => !('functionCall' in part),
  );

  if (nonFunctionParts && nonFunctionParts.length > 0) {
    cleaned[cleaned.length - 1] = {
      ...lastMsg,
      parts: nonFunctionParts,
    };
  } else {
    // No non-function content, remove the message entirely
    cleaned.pop();
  }

  return cleaned;
}
