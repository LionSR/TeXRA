// Third-party imports
import stableStringify from 'fast-json-stable-stringify';
import { z } from 'zod';

// Local imports
import type { AgentTrace } from '@agent/trace';
import type { SdkToolCall } from '@agent/modelHandlers/types/IModelHandler';
import { toErrorMessage } from '@common/errors';
import { safeParseJson } from '@common/parsing/safeParseJson';
import {
  DIAGNOSTIC_TYPE_VALIDATION_ERROR,
  formatZodIssuesForDiagnostics,
  type ValidationErrorDiagnostics,
} from '@shared/schemas/toolResult';

export const DUPLICATE_CALL_ERROR =
  'Duplicate parallel call skipped — same tool name and arguments as an earlier call in this batch. ' +
  'To run identical calls, invoke them sequentially in separate responses.';

/**
 * Identify duplicate parallel tool calls (same name + identical arguments).
 * Returns the set of `callId`s that should be skipped (all but the first
 * occurrence of each unique call signature).
 */
export function findDuplicateCallIds(toolCalls: SdkToolCall[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const call of toolCalls) {
    const key = call.name + '\0' + stableStringify(call.input);
    if (seen.has(key)) {
      duplicates.add(call.callId);
    } else {
      seen.add(key);
    }
  }
  return duplicates;
}

/** Parse tool input, handling JSON strings and other formats from model providers. */
export function parseToolInput(
  raw: unknown,
  callId: string,
  logger: AgentTrace,
): unknown {
  if (raw == null) {
    logger.debug(
      `Tool call ${callId}: Received null input, using empty object`,
    );
    return {};
  }

  if (typeof raw !== 'string') {
    return raw;
  }

  const parsed = safeParseJson(raw);
  if (!parsed.ok) {
    logger.debug(`Tool call ${callId}: Failed to parse input as JSON, using raw string`);
    return raw;
  }
  return parsed.value;
}

/** Normalize a tool call error into a user-friendly message with optional diagnostics. */
export function normalizeToolCallError(
  toolName: string,
  error: unknown,
): { message: string; diagnostics?: ValidationErrorDiagnostics } {
  if (!(error instanceof z.ZodError)) {
    return { message: `${toolName}: ${toErrorMessage(error)}` };
  }

  return {
    message: `${toolName}: Invalid parameters provided`,
    diagnostics: {
      type: DIAGNOSTIC_TYPE_VALIDATION_ERROR,
      issues: error.issues,
      formatted: formatZodIssuesForDiagnostics(error.issues),
    },
  };
}
