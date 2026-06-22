/**
 * Re-export: message normalization now lives in `@agent/export/normalizeConversation`
 * so the command layer doesn't import provider SDK types.
 *
 * @deprecated Import `normalizeConversationForExport` directly from
 *   `@agent/export/normalizeConversation`.
 */

export { normalizeConversationForExport as normalizeMessages } from '@agent/export/normalizeConversation';
