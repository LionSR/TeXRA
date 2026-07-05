// Third-party imports
import stableStringify from 'fast-json-stable-stringify';
import { z } from 'zod';

// Local imports
import type { AgentTrace } from '@agent/trace';
import type { SdkToolCall } from '@agent/modelHandlers/types/IModelHandler';
import { safeParseJson } from '@common/parsing/safeParseJson';
import {
  DIAGNOSTIC_TYPE_VALIDATION_ERROR,
  formatZodIssuesForDiagnostics,
  type ValidationErrorDiagnostics,
} from '@shared/schemas/toolResult';
import { isObject } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
  if (parsed.isErr()) {
    logger.debug(
      `Tool call ${callId}: Failed to parse input as JSON, using raw string`,
    );
    return raw;
  }
  return parsed.value;
}

/**
 * Same as {@link parseToolInput}, but always returns a plain object — for
 * handlers (e.g. streamed argument buffers) whose tool-call arguments must
 * be a Record rather than a possibly-raw string.
 */
export function parseToolInputAsObject(
  raw: string,
  callId: string,
  logger: AgentTrace,
): Record<string, unknown> {
  if (!raw) return {};
  const parsed = parseToolInput(raw, callId, logger);
  return isObject(parsed) ? parsed : {};
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
