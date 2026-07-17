/**
 * Base log formatter utilities for open state management and error handling.
 */
import {
  STREAMING_TEXT_MESSAGE_TYPES,
  type LogMessageData,
} from '@shared/schemas';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';
import { toErrorMessage } from '@utils/errors/errorMessage';

export type FormatOptions = {
  preservedOpen?: boolean;
  defaultOpen?: boolean;
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

/** Result of safeFormat - either success with value or failure with error. */
export type SafeFormatResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

/** Safely execute a formatting function with error handling. */
export function safeFormat<T>(
  formatter: () => T,
  errorContext: string,
): SafeFormatResult<T> {
  try {
    const value = formatter();
    return { ok: true, value };
  } catch (e) {
    const errorMsg = toErrorMessage(e);
    console.error(`Error parsing ${errorContext}:`, e);
    return { ok: false, error: errorMsg };
  }
}
