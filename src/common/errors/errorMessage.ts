/**
 * `toErrorMessage`/`ensureError`/`extractErrorMessage` are host-agnostic and
 * used from webview frontend (browser) code as well as the extension host,
 * so they live canonically in `@utils/errors/errorMessage` (the shared
 * location) rather than here in `common`, which is backend-only. Re-exported
 * for the existing `@common/errors` and `@common/errors/errorMessage`
 * consumers.
 */
export {
  toErrorMessage,
  ensureError,
  extractErrorMessage,
} from '@utils/errors/errorMessage';
