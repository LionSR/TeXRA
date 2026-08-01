/**
 * Shared by the two flow entry points (`runReflectionFlow`, `runToolUseFlow`):
 * both re-throw their persisted `shared.lastError` as a real `Error` so
 * `runFlowWithLifecycle` logs it and shows the user notification, attaching
 * the full structured provider error so downstream formatters can surface
 * statusCode, provider, etc. without sniffing the message string. The two
 * callers construct different `Error` subclasses (ToolUseFlowError carries a
 * partial result payload the outer catch reads back out), so only the
 * attach-and-throw tail is shared here.
 */

import { attachProviderError } from '@common/errors/sdkErrorUtils';
import type { RetryErrorInfo } from '@shared/schemas';

export function throwFlowLastError(
  err: Error,
  lastError: RetryErrorInfo,
): never {
  // `RetryErrorInfo` is a `ProviderError` minus the bulky `rawErrorBody`, so it
  // attaches as-is: the missing field stays absent and `isRelayError` stays
  // `undefined` when it was, keeping `normalizeProviderError` from reading a
  // wrong relay verdict off the retry-state shape.
  attachProviderError(err, lastError);
  throw err;
}
