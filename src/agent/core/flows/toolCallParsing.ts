import stableStringify from 'fast-json-stable-stringify';
import { z } from 'zod';

import type { AgentTrace } from '@agent/trace';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';
import { safeParseJson } from '@common/parsing/safeParseJson';
import {
  DIAGNOSTIC_TYPE_VALIDATION_ERROR,
  formatZodIssuesForDiagnostics,
  type ValidationErrorDiagnostics,
} from '@shared/schemas';
import { isObject } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Map of duplicate callId → index of its primary within this model response
 * (see {@link partitionDuplicateCalls}).
 */
export type DuplicateCallMap = Map<string, number>;

/**
 * Partition duplicate parallel tool calls (same name + identical arguments).
 *
 * Every duplicate is answered with a copy of its primary's result and is
 * never executed — models (especially GPT) routinely emit identical calls in
 * one batch by accident, and a synthetic error for that noise confuses the
 * model and the UI more than a shared success does. Execution still happens
 * only once.
 *
 * Parallel-safe (read-only) sharing is limited to a contiguous run of
 * parallel-safe calls: any side-effect call in between may change what a
 * repeated read would return, so it acts as a barrier that invalidates
 * earlier shareable signatures.
 *
 * Side-effect sharing uses a separate window that resets when a different
 * side-effect call runs in between, since changed state makes an identical
 * repeat plausibly intentional (e.g. write x; edit x; write x as a restore).
 */
export function partitionDuplicateCalls(
  toolCalls: SdkToolCall[],
  isParallelSafe: (call: SdkToolCall) => boolean,
): DuplicateCallMap {
  const sharedWithPrimary: DuplicateCallMap = new Map();
  const segmentPrimaries = new Map<string, number>();
  const unsafeSeen = new Map<string, number>();
  for (const [index, call] of toolCalls.entries()) {
    const key = `${call.name}\0${stableStringify(call.input)}`;
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
        sharedWithPrimary.set(call.callId, unsafePrimary);
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
  return sharedWithPrimary;
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
