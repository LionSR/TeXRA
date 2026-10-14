/**
 * The row kinds TeXRA's plugins own, by plugin id: what the registry gives
 * each plugin, and what an imported trace's reader checks its facts against
 * (`pluginFactFloor`). Browser-safe: it imports only the arms.
 */
import { DOCUMENTS_ACCEPTED_ARM, DOCUMENTS_OUTPUT_ARM } from './documents';
import { EXTERNAL_INQUIRY_THREAD_ARM } from './externalInquiry';

export const APP_PLUGIN_ARMS = {
  documents: [DOCUMENTS_OUTPUT_ARM, DOCUMENTS_ACCEPTED_ARM],
  'external-inquiry': [EXTERNAL_INQUIRY_THREAD_ARM],
} as const;
