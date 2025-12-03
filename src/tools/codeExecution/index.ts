/**
 * Code execution tool support for native server-side code execution
 * across Anthropic, OpenAI, and Google GenAI SDKs.
 *
 * This module provides:
 * - Unified types for code execution display (CodeExecutionDisplay)
 * - Normalizers to convert provider-specific response blocks to unified format
 * - Logging utilities to emit code execution events to progress view
 *
 * ## Display Layer (Implemented)
 * Code execution results are logged and displayed in the progress view.
 *
 * ## Context Layer (TODO)
 * For multi-turn conversations, model handlers need to preserve code execution
 * result blocks (BetaCodeExecutionResultBlock, etc.) when building conversation
 * history. Currently, only text, thinking, and tool_use blocks are preserved.
 * See modelHandlerAnthropic.ts updateMessageContentWithPrefill() and
 * createToolUseFollowUpMessages() for where this should be added.
 */

export * from './types';
export * from './normalizers';
export * from './logCodeExecution';
