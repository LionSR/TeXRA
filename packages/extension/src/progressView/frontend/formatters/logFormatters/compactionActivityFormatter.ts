import '@progressView/frontend/components/CompactionActivity';

import { html } from 'lit';

import type { LogMessageData } from '@shared/schemas';
import { isCompactionActivityBlock } from '@shared/streams/compactionActivityProjection';

import type { FormatResult } from '../baseLogFormatter';

/** Render one projected compaction lifecycle as a stable activity row. */
export function formatCompactionActivityTemplate(
  message: LogMessageData,
): FormatResult {
  if (!isCompactionActivityBlock(message.data)) return null;
  return html`<compaction-activity
    .status=${message.data.status}
  ></compaction-activity>`;
}
