/**
 * Common error handling utilities for the extension host.
 *
 * SDK-specific utilities (isContextWindowError, attachStreamDiagnostics,
 * buildErrorLogData, etc.) should be imported directly from
 * @common/errors/sdkErrorUtils - they are not part of the public barrel.
 */
export {
  formatError,
  formatZodError,
  parseWithErrorDisplay,
  isFileNotFoundError,
  logErrorMessage,
  toErrorMessage,
  showLoggedErrorMessage,
  showLoggedMessage,
  showLoggedInfoMessage,
  showLoggedMessageWithDocs,
} from './errorHandlingUtils';

// These SDK utilities are exposed in the barrel because they have broad usage
// across the codebase (model handlers, runtime, UI layers).
export { formatProviderHttpError, getSdkErrorMessage } from './sdkErrorUtils';
