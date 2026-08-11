/**
 * Common host-neutral error utilities.
 *
 * VS Code notification helpers live in @frontend/ui/errorHandlingUtils.
 * `toErrorMessage`/`ensureError`/`extractErrorMessage` live in
 * @utils/errors/errorMessage (shared with browser/webview code).
 * SDK-specific utilities (isContextWindowError, attachStreamDiagnostics,
 * buildErrorLogData, etc.) live under @common/errors/sdkError/* - import them
 * directly from the defining module; they are not part of the public barrel.
 */
export { formatError } from './errorFormatUtils';
export {
  isFileNotFoundError,
  isModuleNotFoundError,
  isNotADirectoryError,
} from './errorPredicates';
export {
  AGENT_ERROR_OUTCOME,
  classifyAgentError,
  type AgentErrorKind,
} from './agentErrorClassification';

export { AgentError } from './agentErrors';
