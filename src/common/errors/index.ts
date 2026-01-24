// Barrel export for error handling utilities
export {
  DocId,
  formatError,
  formatZodError,
  parseWithErrorDisplay,
  isFileNotFoundError,
  toErrorMessage,
  logErrorMessage,
  showLoggedErrorMessage,
  showLoggedMessage,
  showLoggedInfoMessage,
  showLoggedMessageWithDocs,
} from './errorHandlingUtils';

// Error utility functions
export {
  formatProviderHttpError,
  getSdkErrorMessage,
  isContextWindowError,
  isPreviousResponseIdError,
  buildErrorLogData,
  attachStreamDiagnostics,
} from './sdkErrorUtils';
