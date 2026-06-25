/**
 * Common host-neutral error utilities.
 *
 * VS Code notification helpers live in @frontend/ui/errorHandlingUtils.
 * SDK-specific utilities (isContextWindowError, attachStreamDiagnostics,
 * buildErrorLogData, etc.) should be imported directly from
 * @common/errors/sdkErrorUtils - they are not part of the public barrel.
 */
export { formatError } from './errorFormatUtils';
export { toErrorMessage, ensureError, extractErrorMessage } from './errorMessage';
export {
  isAbortError,
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
export { getSdkErrorMessage, normalizeProviderError } from './sdkErrorUtils';

export { AgentError } from './agentErrors';
