import type { AgentTrace } from '@agent/trace';
import type { Content, Part } from '@google/genai';

/** Type guard for parts that carry a text payload. */
export function isTextPart(part: Part): part is Part & { text: string } {
  return typeof part.text === 'string';
}

/** Extract concatenated text from parts, excluding thought parts. */
export function extractNonThinkingText(parts: Part[], trim = false): string {
  const text = parts
    .filter(
      (part): part is Part & { text: string } =>
        isTextPart(part) && !part.thought,
    )
    .map((part) => part.text)
    .join('');
  return trim ? text.trim() : text;
}

/**
 * Validates that messages have proper alternating user/model turns.
 * All message creation should enforce this natively, so this is a safety check.
 * Logs warnings for any issues found but returns messages unchanged.
 */
export function validateGoogleMessageHistory(
  messages: Content[],
  logger: AgentTrace,
): void {
  let lastRole: string | undefined;

  for (const message of messages) {
    const role = message.role;

    // Check for unsupported roles
    if (role !== 'user' && role !== 'model') {
      logger.warn(
        `Unexpected role in Google message history: ${role}. Expected 'user' or 'model'.`,
      );
    }

    // Check for consecutive same-role messages
    if (lastRole && role === lastRole) {
      logger.warn(
        `Consecutive ${role} messages detected in Google history. This may cause API errors.`,
      );
    }

    // Check for empty parts
    if (!Array.isArray(message.parts) || message.parts.length === 0) {
      logger.warn(`Message with role ${role} has no parts.`);
    }

    lastRole = role;
  }

  logger.debug(`Validated message history length: ${messages.length}`);
}
