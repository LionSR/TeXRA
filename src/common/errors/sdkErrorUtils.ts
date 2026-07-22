/**
 * Public entry point for SDK / provider error classification and formatting.
 *
 * Implementation is split into focused modules under ./sdkError. This barrel
 * preserves the historical `@common/errors/sdkErrorUtils` import surface so
 * external consumers (model handlers, runtime, UI layers) keep working.
 */
export {
  type SdkErrorKind,
  sdkErrorKindFromStatusCode,
  isRetryableStatusCode,
} from './sdkError/sdkErrorKinds';

export {
  attachSdkErrorMetadata,
  attachStreamDiagnostics,
  attachPartialText,
  detectPartialText,
  attachProviderError,
  attachContextWindowError,
  hasContextWindowErrorMarker,
} from './sdkError/errorMetadata';

export { handleStreamingFailure } from './sdkError/streamFailure';

export { detectRequestId, detectStatusCode } from './sdkError/errorInspection';

export {
  PARTIAL_TEXT_TAIL_MAX,
  takeTail,
  isUserAbort,
  isContextWindowError,
  isMissingFinishReasonError,
  isPreviousResponseIdError,
} from './sdkError/errorPatterns';

export {
  formatProviderHttpError,
  normalizeProviderError,
  getSdkErrorMessage,
  buildErrorLogData,
  buildFailedRetryInfo,
} from './sdkError/providerErrorFormat';

export { isRelayMonthlyLimitMessage } from './sdkError/relayDetection';

export {
  parseChatGptSubscriptionLimit,
  describeChatGptSubscriptionLimit,
} from './sdkError/chatgptSubscriptionDetection';
