/**
 * Contains patterns and utilities for handling confirmation prompts in the chat.
 */

// Patterns that indicate the assistant is asking for confirmation
export const CONFIRMATION_PROMPT_PATTERNS: string[] = [
  'Would you like me to',
  'Should I',
  'Do you want me to',
  'Would you prefer',
  'Shall I',
  "Let me know if you'd like me to",
  'I can',
  'I could',
  'Would it be helpful if I',
  'Would that be helpful',
  'Would you find it helpful if I',
  "Is this what you're looking for",
  'Is this what you want',
  'Is this helpful',
  'Is that helpful',
  'Does this help',
  'Does that help',
  'How does this sound',
  'How does that sound',
  'What do you think',
  'Let me know if',
  'Please let me know if',
];

/**
 * Process text to wrap confirmation prompts in monologue tags.
 */
export function wrapConfirmationPrompts(text: string): string {
  const lines = text.split('\n');
  const processedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    // Skip if line is already wrapped in monologue tags
    if (line.startsWith('<monologue>') && line.endsWith('</monologue>')) {
      processedLines.push(line);
      continue;
    }

    // Check if line contains confirmation prompt
    if (
      CONFIRMATION_PROMPT_PATTERNS.some((pattern) =>
        line.toLowerCase().includes(pattern.toLowerCase()),
      )
    ) {
      // Check if line is already wrapped in separate monologue tags
      if (
        i > 0 &&
        i < lines.length - 1 &&
        lines[i - 1].trim() === '<monologue>' &&
        lines[i + 1].trim() === '</monologue>'
      ) {
        processedLines.push(line);
      } else {
        processedLines.push(`<monologue>${line}</monologue>`);
      }
    } else {
      processedLines.push(line);
    }
  }

  return processedLines.join('\n');
}
