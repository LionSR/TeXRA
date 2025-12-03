/**
 * Normalizer functions to convert provider-specific code execution responses
 * to the unified CodeExecutionDisplay type.
 */

import type {
  CodeExecutionDisplay,
  CodeExecutionOutput,
  CodeExecutionStatus,
  CodeExecutionLanguage,
} from './types';

// ============================================================================
// Anthropic Normalizers
// ============================================================================

/**
 * Anthropic BetaCodeExecutionResultBlock shape from SDK
 */
interface AnthropicCodeExecutionResult {
  type: 'code_execution_result';
  content: Array<{ file_id: string; type: 'code_execution_output' }>;
  return_code: number;
  stdout: string;
  stderr: string;
}

/**
 * Anthropic BetaBashCodeExecutionResultBlock shape from SDK
 */
interface AnthropicBashCodeExecutionResult {
  type: 'bash_code_execution_result';
  content: Array<{ file_id: string; type: 'bash_code_execution_output' }>;
  return_code: number;
  stdout: string;
  stderr: string;
}

/**
 * Anthropic code execution error shape
 */
interface AnthropicCodeExecutionError {
  type: 'code_execution_tool_result_error' | 'bash_code_execution_tool_result_error';
  error_code:
    | 'invalid_tool_input'
    | 'unavailable'
    | 'too_many_requests'
    | 'execution_time_exceeded'
    | 'output_file_too_large';
}

type AnthropicCodeExecutionContent =
  | AnthropicCodeExecutionResult
  | AnthropicBashCodeExecutionResult
  | AnthropicCodeExecutionError;

/**
 * Normalize Anthropic code execution result to unified format
 */
export function normalizeAnthropicCodeExecution(
  content: AnthropicCodeExecutionContent,
  toolUseId?: string,
  code?: string,
): CodeExecutionDisplay {
  // Handle error case
  if (
    content.type === 'code_execution_tool_result_error' ||
    content.type === 'bash_code_execution_tool_result_error'
  ) {
    const errorContent = content as AnthropicCodeExecutionError;
    const status = mapAnthropicErrorToStatus(errorContent.error_code);
    return {
      provider: 'anthropic',
      language: content.type.includes('bash') ? 'bash' : 'python',
      code: code ?? '',
      status,
      errorCode: errorContent.error_code,
      errorMessage: getAnthropicErrorMessage(errorContent.error_code),
      toolUseId,
    };
  }

  // Handle success case
  const result = content as
    | AnthropicCodeExecutionResult
    | AnthropicBashCodeExecutionResult;
  const isBash = result.type === 'bash_code_execution_result';
  const status: CodeExecutionStatus =
    result.return_code === 0 ? 'success' : 'failed';

  const outputs: CodeExecutionOutput[] = result.content.map((output) => ({
    type: 'file' as const,
    fileId: output.file_id,
  }));

  return {
    provider: 'anthropic',
    language: isBash ? 'bash' : 'python',
    code: code ?? '',
    status,
    returnCode: result.return_code,
    stdout: result.stdout || undefined,
    stderr: result.stderr || undefined,
    outputs: outputs.length > 0 ? outputs : undefined,
    toolUseId,
  };
}

function mapAnthropicErrorToStatus(
  errorCode: AnthropicCodeExecutionError['error_code'],
): CodeExecutionStatus {
  switch (errorCode) {
    case 'execution_time_exceeded':
      return 'timeout';
    default:
      return 'failed';
  }
}

function getAnthropicErrorMessage(
  errorCode: AnthropicCodeExecutionError['error_code'],
): string {
  switch (errorCode) {
    case 'invalid_tool_input':
      return 'Invalid input provided to code execution tool';
    case 'unavailable':
      return 'Code execution service is currently unavailable';
    case 'too_many_requests':
      return 'Too many code execution requests';
    case 'execution_time_exceeded':
      return 'Code execution exceeded time limit';
    case 'output_file_too_large':
      return 'Output file size exceeded limit';
    default:
      return 'Unknown error during code execution';
  }
}

// ============================================================================
// OpenAI Normalizers
// ============================================================================

/**
 * OpenAI ResponseCodeInterpreterToolCall shape from SDK
 */
interface OpenAICodeInterpreterToolCall {
  id: string;
  type: 'code_interpreter_call';
  code: string | null;
  container_id: string;
  status: 'in_progress' | 'completed' | 'incomplete' | 'interpreting' | 'failed';
  outputs: Array<
    | { type: 'logs'; logs: string }
    | { type: 'image'; url: string }
  > | null;
}

/**
 * OpenAI Assistant API CodeInterpreterToolCall shape
 */
interface OpenAIAssistantCodeInterpreter {
  id: string;
  type: 'code_interpreter';
  code_interpreter: {
    input: string;
    outputs: Array<
      | { type: 'logs'; logs: string }
      | { type: 'image'; image: { file_id: string } }
    >;
  };
}

/**
 * Normalize OpenAI Responses API code interpreter to unified format
 */
export function normalizeOpenAICodeInterpreter(
  toolCall: OpenAICodeInterpreterToolCall,
): CodeExecutionDisplay {
  const status = mapOpenAIStatusToStatus(toolCall.status);

  const outputs: CodeExecutionOutput[] = [];
  let stdout: string | undefined;

  if (toolCall.outputs) {
    for (const output of toolCall.outputs) {
      if (output.type === 'logs') {
        // Accumulate logs as stdout
        stdout = stdout ? `${stdout}\n${output.logs}` : output.logs;
        outputs.push({
          type: 'logs',
          content: output.logs,
        });
      } else if (output.type === 'image') {
        outputs.push({
          type: 'image',
          url: output.url,
        });
      }
    }
  }

  return {
    provider: 'openai',
    language: 'python', // OpenAI code interpreter is Python
    code: toolCall.code ?? '',
    status,
    stdout,
    outputs: outputs.length > 0 ? outputs : undefined,
    toolUseId: toolCall.id,
  };
}

/**
 * Normalize OpenAI Assistant API code interpreter to unified format
 */
export function normalizeOpenAIAssistantCodeInterpreter(
  toolCall: OpenAIAssistantCodeInterpreter,
): CodeExecutionDisplay {
  const outputs: CodeExecutionOutput[] = [];
  let stdout: string | undefined;

  for (const output of toolCall.code_interpreter.outputs) {
    if (output.type === 'logs') {
      stdout = stdout ? `${stdout}\n${output.logs}` : output.logs;
      outputs.push({
        type: 'logs',
        content: output.logs,
      });
    } else if (output.type === 'image') {
      outputs.push({
        type: 'image',
        fileId: output.image.file_id,
      });
    }
  }

  return {
    provider: 'openai',
    language: 'python',
    code: toolCall.code_interpreter.input,
    status: 'success', // Assistant API doesn't provide status in the same way
    stdout,
    outputs: outputs.length > 0 ? outputs : undefined,
    toolUseId: toolCall.id,
  };
}

function mapOpenAIStatusToStatus(
  status: OpenAICodeInterpreterToolCall['status'],
): CodeExecutionStatus {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'failed';
    case 'in_progress':
    case 'interpreting':
      return 'running';
    case 'incomplete':
      return 'cancelled';
    default:
      return 'failed';
  }
}

// ============================================================================
// Google GenAI Normalizers
// ============================================================================

/**
 * Google ExecutableCode shape from SDK
 */
interface GoogleExecutableCode {
  code?: string;
  language?: 'LANGUAGE_UNSPECIFIED' | 'PYTHON';
}

/**
 * Google CodeExecutionResult shape from SDK
 */
interface GoogleCodeExecutionResult {
  outcome?:
    | 'OUTCOME_UNSPECIFIED'
    | 'OUTCOME_OK'
    | 'OUTCOME_FAILED'
    | 'OUTCOME_DEADLINE_EXCEEDED';
  output?: string;
}

/**
 * Normalize Google GenAI code execution to unified format
 */
export function normalizeGoogleCodeExecution(
  executableCode: GoogleExecutableCode,
  result: GoogleCodeExecutionResult,
): CodeExecutionDisplay {
  const status = mapGoogleOutcomeToStatus(result.outcome);
  const language = mapGoogleLanguage(executableCode.language);

  // Google returns stdout on success, stderr on failure in the same field
  const isSuccess = status === 'success';

  return {
    provider: 'google',
    language,
    code: executableCode.code ?? '',
    status,
    stdout: isSuccess ? result.output : undefined,
    stderr: !isSuccess ? result.output : undefined,
  };
}

function mapGoogleOutcomeToStatus(
  outcome?: GoogleCodeExecutionResult['outcome'],
): CodeExecutionStatus {
  switch (outcome) {
    case 'OUTCOME_OK':
      return 'success';
    case 'OUTCOME_FAILED':
      return 'failed';
    case 'OUTCOME_DEADLINE_EXCEEDED':
      return 'timeout';
    case 'OUTCOME_UNSPECIFIED':
    default:
      return 'failed';
  }
}

function mapGoogleLanguage(
  language?: GoogleExecutableCode['language'],
): CodeExecutionLanguage {
  switch (language) {
    case 'PYTHON':
      return 'python';
    default:
      return 'unknown';
  }
}

// ============================================================================
// Generic Helpers
// ============================================================================

/**
 * Type guard for Anthropic code execution result blocks
 */
export function isAnthropicCodeExecutionResult(
  block: unknown,
): block is AnthropicCodeExecutionContent {
  if (!block || typeof block !== 'object') return false;
  const b = block as { type?: string };
  return (
    b.type === 'code_execution_result' ||
    b.type === 'bash_code_execution_result' ||
    b.type === 'code_execution_tool_result_error' ||
    b.type === 'bash_code_execution_tool_result_error'
  );
}

/**
 * Type guard for OpenAI code interpreter tool calls
 */
export function isOpenAICodeInterpreterCall(
  block: unknown,
): block is OpenAICodeInterpreterToolCall {
  if (!block || typeof block !== 'object') return false;
  const b = block as { type?: string };
  return b.type === 'code_interpreter_call';
}

/**
 * Type guard for OpenAI Assistant code interpreter
 */
export function isOpenAIAssistantCodeInterpreter(
  block: unknown,
): block is OpenAIAssistantCodeInterpreter {
  if (!block || typeof block !== 'object') return false;
  const b = block as { type?: string; code_interpreter?: unknown };
  return b.type === 'code_interpreter' && b.code_interpreter !== undefined;
}

/**
 * Type guard for Google code execution parts
 */
export function isGoogleCodeExecutionPart(
  part: unknown,
): part is { executableCode?: GoogleExecutableCode; codeExecutionResult?: GoogleCodeExecutionResult } {
  if (!part || typeof part !== 'object') return false;
  const p = part as {
    executableCode?: unknown;
    codeExecutionResult?: unknown;
  };
  return p.executableCode !== undefined || p.codeExecutionResult !== undefined;
}
