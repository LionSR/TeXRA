import type { AgentTrace } from '@agent/trace';
import { safeParseJson } from '@common/parsing/safeParseJson';

/**
 * Safely parse tool call arguments from raw string to object.
 * Returns the original value if not a string, or if JSON parsing fails.
 */
export function parseToolArguments(raw: unknown, logger: AgentTrace): unknown {
  if (typeof raw !== 'string') {
    return raw;
  }

  const parsed = safeParseJson(raw);
  if (!parsed.ok) {
    logger.warn(
      'Tool call arguments could not be parsed as JSON; using raw string.',
      { data: parsed.error },
    );
    return raw;
  }
  return parsed.value;
}
