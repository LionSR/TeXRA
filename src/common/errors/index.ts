/**
 * Error handling utilities barrel export.
 *
 * Only exports utilities that are commonly imported via this barrel.
 * For SDK-specific error utilities (isContextWindowError, attachStreamDiagnostics, etc.),
 * import directly from @common/errors/sdkErrorUtils.
 */
export {
  formatError,
  formatZodError,
  parseWithErrorDisplay,
  isFileNotFoundError,
  toErrorMessage,
  showLoggedErrorMessage,
  showLoggedMessage,
  showLoggedInfoMessage,
  showLoggedMessageWithDocs,
} from './errorHandlingUtils';

export { formatProviderHttpError, getSdkErrorMessage } from './sdkErrorUtils';
