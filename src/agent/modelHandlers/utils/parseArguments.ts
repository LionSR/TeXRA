import type { AgentTrace } from '@agent/trace';
import { safeParseJson } from '@common/parsing/safeParseJson';
import { isObject } from '@utils/core';

const DEFAULT_PARSE_FAILURE_MESSAGE =
  'Tool call arguments could not be parsed as JSON; using raw string.';

/**
 * Safely parse tool call arguments from raw string to object.
 * Returns the original value if not a string, or if JSON parsing fails.
 *
 * `warnMessage` lets callers whose fallback behavior differs from "use the
 * raw string" (e.g. {@link parseToolArgumentsAsObject}, which discards the
 * raw string and falls back to `{}`) log an accurate description instead.
 */
export function parseToolArguments(
  raw: unknown,
  logger: AgentTrace,
  warnMessage = DEFAULT_PARSE_FAILURE_MESSAGE,
): unknown {
  if (typeof raw !== 'string') {
    return raw;
  }

  const parsed = safeParseJson(raw);
  if (parsed.isErr()) {
    logger.warn(warnMessage, { data: parsed.error });
    return raw;
  }
  return parsed.value;
}

/**
 * Same as {@link parseToolArguments}, but always returns a plain object —
 * for handlers (e.g. streamed argument buffers) whose tool-call arguments
 * must be a Record rather than a possibly-raw string.
 */
export function parseToolArgumentsAsObject(
  raw: string,
  logger: AgentTrace,
): Record<string, unknown> {
  if (!raw) return {};
  const parsed = parseToolArguments(
    raw,
    logger,
    'Failed to parse streamed tool arguments.',
  );
  return isObject(parsed) ? parsed : {};
}
