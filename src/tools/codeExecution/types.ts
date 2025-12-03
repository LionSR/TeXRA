/**
 * Unified code execution types for native server-side code execution
 * across Anthropic, OpenAI, and Google GenAI SDKs.
 */

import { z } from 'zod';

/**
 * Execution status across all providers
 */
export const CodeExecutionStatusSchema = z.enum([
  'running',
  'success',
  'failed',
  'timeout',
  'cancelled',
  'unknown',
]);
export type CodeExecutionStatus = z.infer<typeof CodeExecutionStatusSchema>;

/**
 * Supported providers for native code execution
 */
export const CodeExecutionProviderSchema = z.enum([
  'anthropic',
  'openai',
  'google',
]);
export type CodeExecutionProvider = z.infer<typeof CodeExecutionProviderSchema>;

/**
 * Programming language for execution
 */
export const CodeExecutionLanguageSchema = z.enum([
  'python',
  'bash',
  'javascript',
  'unknown',
]);
export type CodeExecutionLanguage = z.infer<typeof CodeExecutionLanguageSchema>;

/**
 * Output types from code execution
 */
export const CodeExecutionOutputTypeSchema = z.enum([
  'logs',
  'image',
  'file',
]);
export type CodeExecutionOutputType = z.infer<
  typeof CodeExecutionOutputTypeSchema
>;

/**
 * Individual output from code execution (logs, images, files)
 */
export const CodeExecutionOutputSchema = z.object({
  type: CodeExecutionOutputTypeSchema,
  /** Text content for logs */
  content: z.string().optional(),
  /** URL for images (OpenAI) */
  url: z.string().optional(),
  /** File ID reference (Anthropic, OpenAI) */
  fileId: z.string().optional(),
  /** MIME type for files/images */
  mimeType: z.string().optional(),
});
export type CodeExecutionOutput = z.infer<typeof CodeExecutionOutputSchema>;

/**
 * Unified code execution display data structure.
 * Normalizes responses from Anthropic, OpenAI, and Google SDKs.
 */
export const CodeExecutionDisplaySchema = z.object({
  /** Provider that executed the code */
  provider: CodeExecutionProviderSchema,
  /** Programming language */
  language: CodeExecutionLanguageSchema,
  /** The executed code */
  code: z.string(),
  /** Execution status */
  status: CodeExecutionStatusSchema,
  /** Exit/return code (Anthropic) */
  returnCode: z.number().optional(),
  /** Standard output */
  stdout: z.string().optional(),
  /** Standard error */
  stderr: z.string().optional(),
  /** Additional outputs (images, files) */
  outputs: z.array(CodeExecutionOutputSchema).optional(),
  /** Execution duration in milliseconds */
  durationMs: z.number().optional(),
  /** Tool use ID for correlation */
  toolUseId: z.string().optional(),
  /** Error message if execution failed */
  errorMessage: z.string().optional(),
  /** Error code from provider */
  errorCode: z.string().optional(),
});
export type CodeExecutionDisplay = z.infer<typeof CodeExecutionDisplaySchema>;

/**
 * Anthropic-specific error codes for code execution
 */
export const AnthropicCodeExecutionErrorCodeSchema = z.enum([
  'invalid_tool_input',
  'unavailable',
  'too_many_requests',
  'execution_time_exceeded',
  'output_file_too_large',
]);
export type AnthropicCodeExecutionErrorCode = z.infer<
  typeof AnthropicCodeExecutionErrorCodeSchema
>;

/**
 * Google-specific outcome codes
 */
export const GoogleCodeExecutionOutcomeSchema = z.enum([
  'OUTCOME_UNSPECIFIED',
  'OUTCOME_OK',
  'OUTCOME_FAILED',
  'OUTCOME_DEADLINE_EXCEEDED',
]);
export type GoogleCodeExecutionOutcome = z.infer<
  typeof GoogleCodeExecutionOutcomeSchema
>;

/**
 * OpenAI-specific status codes
 */
export const OpenAICodeInterpreterStatusSchema = z.enum([
  'in_progress',
  'completed',
  'incomplete',
  'interpreting',
  'failed',
]);
export type OpenAICodeInterpreterStatus = z.infer<
  typeof OpenAICodeInterpreterStatusSchema
>;
