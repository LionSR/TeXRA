/** Web-search log-entry formatter: the query label is the whole row. */

import { html } from 'lit';

import { rowHeadline, type WebSearchRow } from '@texra-ai/harness/transcript';
import type { FormatResult } from '@ui/progress/formatters/baseLogFormatter';
import { buildToolUseDetails } from './helpers';

export function formatWebSearchTemplate(row: WebSearchRow): FormatResult {
  return buildToolUseDetails({
    row,
    iconName: 'globe',
    label: rowHeadline(row),
    isError: false,
    content: html``,
  });
}
