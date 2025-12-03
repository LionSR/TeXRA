/**
 * Utility for logging code execution events to the progress view.
 */

// Third-party imports
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Local imports
import type { AgentLogger } from '@logger/AgentLogger';
import {
  normalizeAnthropicCodeExecution,
  normalizeOpenAICodeInterpreter,
  normalizeGoogleCodeExecution,
  isAnthropicCodeExecutionResult,
  isOpenAICodeInterpreterCall,
  isGoogleCodeExecutionPart,
} from './normalizers';

// Type imports
import type { CodeExecutionDisplay } from './types';

/**
 * Log a code execution event to the progress view
 */
export function logCodeExecution(
  logger: AgentLogger,
  data: CodeExecutionDisplay,
  groupId?: string,
): void {
  logger.info('', {
    groupId,
    messageType: MESSAGE_TYPES.CODE_EXECUTION,
    data,
  });
}

/**
 * Process and log Anthropic code execution result blocks
 * @returns true if any code execution blocks were found and logged
 */
export function processAnthropicCodeExecutionBlocks(
  logger: AgentLogger,
  contentBlocks: unknown[],
  groupId?: string,
): boolean {
  let found = false;

  for (const block of contentBlocks) {
    if (isAnthropicCodeExecutionResult(block)) {
      // Extract code from corresponding tool_use block if available
      // For now, we don't have access to the original code, so leave it empty
      const display = normalizeAnthropicCodeExecution(block, undefined, '');
      logCodeExecution(logger, display, groupId);
      found = true;
    }
  }

  return found;
}

/**
 * Process and log OpenAI code interpreter tool calls
 * @returns true if any code interpreter calls were found and logged
 */
export function processOpenAICodeInterpreterCalls(
  logger: AgentLogger,
  toolCalls: unknown[],
  groupId?: string,
): boolean {
  let found = false;

  for (const call of toolCalls) {
    if (isOpenAICodeInterpreterCall(call)) {
      const display = normalizeOpenAICodeInterpreter(call);
      logCodeExecution(logger, display, groupId);
      found = true;
    }
  }

  return found;
}

/**
 * Process and log Google GenAI code execution parts
 * @returns true if any code execution parts were found and logged
 */
export function processGoogleCodeExecutionParts(
  logger: AgentLogger,
  parts: unknown[],
  groupId?: string,
): boolean {
  let found = false;

  // Google returns executable code and result as separate parts
  // We need to pair them up
  type GoogleLanguage = 'LANGUAGE_UNSPECIFIED' | 'PYTHON';
  type GoogleOutcome =
    | 'OUTCOME_UNSPECIFIED'
    | 'OUTCOME_OK'
    | 'OUTCOME_FAILED'
    | 'OUTCOME_DEADLINE_EXCEEDED';

  let pendingCode: { code?: string; language?: GoogleLanguage } | null = null;

  for (const part of parts) {
    if (isGoogleCodeExecutionPart(part)) {
      const p = part as {
        executableCode?: { code?: string; language?: GoogleLanguage };
        codeExecutionResult?: { outcome?: GoogleOutcome; output?: string };
      };

      if (p.executableCode) {
        pendingCode = p.executableCode;
      }

      if (p.codeExecutionResult && pendingCode) {
        const display = normalizeGoogleCodeExecution(
          pendingCode,
          p.codeExecutionResult,
        );
        logCodeExecution(logger, display, groupId);
        pendingCode = null;
        found = true;
      }
    }
  }

  return found;
}
