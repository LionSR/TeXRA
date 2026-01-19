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
  ErrorLogDataSchema,
  ErrorContextSchema,
  ProviderErrorPartialSchema,
  RetryErrorInfoSchema,
  type ProviderError,
  type ErrorLogData,
  type ErrorContext,
  type ProviderErrorPartial,
  type RetryErrorInfo,
} from './schemas';

// Error utility functions
export {
  formatProviderHttpError,
  getSdkErrorMessage,
  isContextWindowError,
  isPreviousResponseIdError,
  buildErrorLogData,
} from './sdkErrorUtils';
