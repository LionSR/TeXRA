// Third-party imports
import stableStringify from 'fast-json-stable-stringify';
import { z } from 'zod';

// Local imports
import type { AgentTrace } from '@agent/trace';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';
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

/** Duplicate-call partition for one model response (see partitionDuplicateCalls). */
export interface DuplicateCallPartition {
  /** Duplicate callId → index of its primary within the same safe segment. */
  sharedWithPrimary: Map<string, number>;
  /**
   * Duplicates of side-effect tools, mapped to their primary's index —
   * never executed; answered with an error only when the primary actually
   * ran (an interrupted primary leaves the duplicate cancelled with it).
   */
  rejected: Map<string, number>;
}

/**
 * Partition duplicate parallel tool calls (same name + identical arguments).
 *
 * Parallel-safe (read-only) duplicates share their primary's result — but
 * only within a contiguous run of parallel-safe calls: any side-effect call
 * in between may change what a repeated read would return, so it acts as a
 * barrier that invalidates earlier shareable signatures.
 *
 * Side-effect duplicates are rejected with a synthetic error (sharing a
 * success would misreport an effect that never ran; running it silently
 * twice is equally wrong) — a false positive only costs the model one
 * explicit sequential re-issue. The rejection window resets when a
 * different side-effect call runs in between, since changed state makes an
 * identical repeat plausibly intentional.
 */
export function partitionDuplicateCalls(
  toolCalls: SdkToolCall[],
  isParallelSafe: (call: SdkToolCall) => boolean,
): DuplicateCallPartition {
  const sharedWithPrimary = new Map<string, number>();
  const rejected = new Map<string, number>();
  const segmentPrimaries = new Map<string, number>();
  const unsafeSeen = new Map<string, number>();
  for (const [index, call] of toolCalls.entries()) {
    const key = call.name + '\0' + stableStringify(call.input);
    if (isParallelSafe(call)) {
      const primary = segmentPrimaries.get(key);
      if (primary !== undefined) {
        sharedWithPrimary.set(call.callId, primary);
      } else {
        segmentPrimaries.set(key, index);
      }
    } else {
      // Barrier: workspace state may change, so pre-barrier reads are stale.
      segmentPrimaries.clear();
      const unsafePrimary = unsafeSeen.get(key);
      if (unsafePrimary !== undefined) {
        rejected.set(call.callId, unsafePrimary);
      } else {
        // A different mutation changes workspace state, which makes an
        // identical repeat of an earlier mutation plausibly intentional
        // again (e.g. write x; edit x; write x as a restore) — reset the
        // tracking window. Parallel-safe calls do not reset it: with state
        // unchanged, an identical mutation repeat stays redundant.
        unsafeSeen.clear();
        unsafeSeen.set(key, index);
      }
    }
  }
  return { sharedWithPrimary, rejected };
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
