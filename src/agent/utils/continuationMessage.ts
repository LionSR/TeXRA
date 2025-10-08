/**
 * Creates a continuation message prompting the model to resume from where it left off.
 * @param endTag - The tag that marks the end of the response
 * @param prefillTokens - The last K tokens from the previous response
 * @returns Formatted continuation prompt
 */
export const createContinuationMessage = (
  endTag: string,
  prefillTokens: string,
): string =>
  `Your response got cut off, because you only have limited response space. ` +
  `Continue responding exactly from where you left off until the very end, ` +
  `marked by ${endTag}. ` +
  'Avoid repeating yourself and avoid starting over. ' +
  `Start your response at the next token after: "${prefillTokens}"`;
