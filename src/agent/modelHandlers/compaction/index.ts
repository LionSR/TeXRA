/**
 * Context compaction module for client-side summarization.
 *
 * This module provides a unified compaction strategy for all model handlers
 * except OpenAI Responses API (which uses native /responses/compact endpoint).
 *
 * Usage:
 * - Import the appropriate compaction function for your provider
 * - Call with messages and compaction model to get a summary
 * - Replace all messages with a single user message containing the summary
 */

// Types
export * from './types';

// Prompts
export { DEFAULT_SUMMARY_PROMPT, SUMMARY_TAG, CONVERSATION_SUMMARY_TAG } from './compactionPrompt';

// Model mapping
export { COMPACTION_MODEL_MAP, getCompactionModel } from './compactionModelMap';

// Provider-specific compaction functions
export { compactOpenAICompatible } from './openaiCompatibleCompaction';
export { compactAnthropic } from './anthropicCompaction';
export { compactGoogleGenAI } from './googleGenAICompaction';
