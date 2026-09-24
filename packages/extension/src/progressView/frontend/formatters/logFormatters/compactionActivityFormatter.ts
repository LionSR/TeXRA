import '@progressView/frontend/components/CompactionActivity';

import { html } from 'lit';

import type { CompactionActivityRow } from '@ui/transcript';

import type { FormatResult } from '../baseLogFormatter';

/** Render one projected compaction lifecycle as a stable activity row. */
export function formatCompactionActivityTemplate(
  row: CompactionActivityRow,
): FormatResult {
  return html`<compaction-activity
    .status=${row.block.status}
    .label=${row.label}
  ></compaction-activity>`;
}
