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
  ProviderErrorPartialSchema,
  RetryErrorInfoSchema,
  StreamDiagnosticsSchema,
  type ProviderError,
  type ProviderErrorPartial,
  type RetryErrorInfo,
  type StreamDiagnostics,
} from '@shared/schemas';
export {
  ErrorLogDataSchema,
  ErrorContextSchema,
  type ErrorLogData,
  type ErrorContext,
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
