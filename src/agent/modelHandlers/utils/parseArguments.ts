import type { AgentTrace } from '@agent/trace';

/**
 * Safely parse tool call arguments from raw string to object.
 * Returns the original value if not a string, or if JSON parsing fails.
 */
export function parseToolArguments(raw: unknown, logger: AgentTrace): unknown {
  if (typeof raw !== 'string') {
    return raw;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    logger.warn(
      'Tool call arguments could not be parsed as JSON; using raw string.',
      { data: error },
    );
    return raw;
  }
}
