/**
 * Base log formatter types and open-state helpers.
 */

import {
  STREAMING_TEXT_MESSAGE_TYPES,
  type LogMessageData,
} from '@shared/schemas';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';
import type { TemplateResult } from 'lit';

/** Result type for formatters that return Lit templates directly. */
export type FormatResult = TemplateResult | null;

export type FormatOptions = {
  executionLabels?: ExecutionLabels;
};

function isRunningData(data: unknown): boolean {
  return (
    data !== null &&
    typeof data === 'object' &&
    'status' in data &&
    data.status === 'running'
  );
}

/** True while a thinking/scratchpad/model-response entry is still streaming in. */
export function isStreamingTextLogMessage(message: LogMessageData): boolean {
  return (
    STREAMING_TEXT_MESSAGE_TYPES.has(message.messageType ?? '') &&
    isRunningData(message.data)
  );
}
