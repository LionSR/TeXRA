// Barrel export for error handling utilities
export {
  DocId,
  formatError,
  isFileNotFoundError,
  toErrorMessage,
  logErrorMessage,
  showLoggedErrorMessage,
  showLoggedMessage,
  showLoggedInfoMessage,
  showLoggedMessageWithDocs,
  // FileType utilities for platform-agnostic file operations
  FileType,
  FileTypeValue,
  isFile,
  isDirectory,
} from './errorHandlingUtils';
export {
  ProviderHttpErrorDetails,
  ErrorLogContext,
  ErrorLogData,
  formatProviderHttpError,
  getSdkErrorMessage,
  isContextWindowError,
  enrichError,
  buildErrorLogData,
} from './sdkErrorUtils';
