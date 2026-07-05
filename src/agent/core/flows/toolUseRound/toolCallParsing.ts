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

export const UNSAFE_DUPLICATE_CALL_ERROR =
  'Duplicate parallel call skipped — same tool name and arguments as an earlier call in this batch, ' +
  'and this tool has side effects, so its result cannot be shared. ' +
  'If you intend the effect to run twice, invoke it again sequentially in your next response.';

/**
 * Map duplicate parallel tool calls (same name + identical arguments) to
 * their primary occurrence. Returns duplicate `callId` → index of the first
 * occurrence in `toolCalls`; only the primary executes, and duplicates
 * receive a copy of its result — a byte-identical call has a known answer,
 * so re-asking the model to retry sequentially would burn a full round-trip
 * for nothing.
 */
export function mapDuplicateCallsToPrimary(
  toolCalls: SdkToolCall[],
): Map<string, number> {
  const primaryBySignature = new Map<string, number>();
  const duplicateToPrimary = new Map<string, number>();
  for (const [index, call] of toolCalls.entries()) {
    const key = call.name + '\0' + stableStringify(call.input);
    const primary = primaryBySignature.get(key);
    if (primary !== undefined) {
      duplicateToPrimary.set(call.callId, primary);
    } else {
      primaryBySignature.set(key, index);
    }
  }
  return duplicateToPrimary;
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
