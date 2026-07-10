import { summarizeFollowupMessage } from '@shared/subagentFollowup';

import { textDisplayWidth, truncateSummaryToWidth } from './terminalText';

/** Render `"{index+1}. {summary}"`, truncating the summary to fit `maxColumns`. */
export function numberedFollowUpPreview(
  message: string,
  index: number,
  maxColumns: number,
): string {
  const prefix = `${index + 1}. `;
  const bodyColumns = Math.max(0, maxColumns - textDisplayWidth(prefix));
  return `${prefix}${truncateSummaryToWidth(
    summarizeFollowupMessage(message),
    bodyColumns,
  )}`;
}
