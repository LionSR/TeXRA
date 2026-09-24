/** Web-search log-entry formatter: the query label is the whole row. */

import { html } from 'lit';

import type { FormatResult } from '@progressView/frontend/formatters/baseLogFormatter';
import type { WebSearchRow } from '@ui/transcript';
import { buildToolUseDetails } from './helpers';

export function formatWebSearchTemplate(row: WebSearchRow): FormatResult {
  return buildToolUseDetails({
    row,
    iconName: 'globe',
    label: row.label,
    isError: false,
    content: html``,
  });
}
