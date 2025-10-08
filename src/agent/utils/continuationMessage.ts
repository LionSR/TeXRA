export const createContinuationMessage = (
  endTag: string,
  prefillTokens: string,
): string =>
  `Your response got cut off, because you only have limited response space. ` +
  `Continue responding exactly from where you left off until the very end, ` +
  `marked by ${endTag}. ` +
  'Avoid repeat yourself and avoid starting over. ' +
  `Start your response at the next token after: "${prefillTokens}"`;

