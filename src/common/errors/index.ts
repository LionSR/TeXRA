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

// Canonical error schemas - SINGLE SOURCE OF TRUTH
export {
  ProviderErrorSchema,
  RetryErrorInfoSchema,
  StreamDiagnosticsSchema,
  type ProviderError,
  type RetryErrorInfo,
  type StreamDiagnostics,
} from '@shared/schemas';

export {
  ErrorLogDataSchema,
  ErrorContextSchema,
  ProviderErrorPartialSchema,
  type ErrorLogData,
  type ErrorContext,
  type ProviderErrorPartial,
} from './schemas';

// Error utility functions
export {
  formatProviderHttpError,
  getSdkErrorMessage,
  isContextWindowError,
  isPreviousResponseIdError,
  buildErrorLogData,
  attachStreamDiagnostics,
} from './sdkErrorUtils';
