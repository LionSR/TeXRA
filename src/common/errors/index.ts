/**
 * Common host-neutral error utilities.
 *
 * VS Code notification helpers live in @frontend/ui/errorHandlingUtils.
 * `toErrorMessage`/`ensureError`/`extractErrorMessage` live in
 * @utils/errors/errorMessage (shared with browser/webview code).
 * SDK-specific utilities (isContextWindowError, attachStreamDiagnostics,
 * buildErrorLogData, etc.) should be imported directly from
 * @common/errors/sdkErrorUtils - they are not part of the public barrel.
 */
export { formatError } from './errorFormatUtils';
export {
  isADirectoryError,
  isFileNotFoundError,
  isModuleNotFoundError,
  isNotADirectoryError,
} from './errorPredicates';
export {
  AGENT_ERROR_OUTCOME,
  classifyAgentError,
  type AgentErrorKind,
} from './agentErrorClassification';

// These SDK utilities are exposed in the barrel because they have broad usage
// across the codebase (model handlers, runtime, UI layers).
// normalizeProviderError is the single public normalization entry; the
// non-caching formatProviderHttpError stays internal to sdkErrorUtils.
export {
  getSdkErrorMessage,
  normalizeProviderError,
  buildFailedRetryInfo,
} from './sdkErrorUtils';

export { AgentError } from './agentErrors';
