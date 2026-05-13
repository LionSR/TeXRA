/**
 * Common host-neutral error utilities.
 *
 * VS Code notification helpers live in @frontend/ui/errorHandlingUtils.
 * SDK-specific utilities (isContextWindowError, attachStreamDiagnostics,
 * buildErrorLogData, etc.) should be imported directly from
 * @common/errors/sdkErrorUtils - they are not part of the public barrel.
 */
export { formatError, formatZodError } from './errorFormatUtils';
export { toErrorMessage } from './errorMessage';
export { isDiskFullError, isFileNotFoundError } from './errorPredicates';
export {
  classifyAgentError,
  type AgentErrorKind,
} from './agentErrorClassification';

// These SDK utilities are exposed in the barrel because they have broad usage
// across the codebase (model handlers, runtime, UI layers).
export {
  formatProviderHttpError,
  getSdkErrorMessage,
  normalizeProviderError,
} from './sdkErrorUtils';

export { AgentError } from './agentErrors';
