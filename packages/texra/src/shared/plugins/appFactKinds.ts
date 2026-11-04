/**
 * The row kinds TeXRA's plugins own, by plugin id: what the registry gives
 * each plugin, and what an imported trace's reader checks its facts against
 * (`pluginFactFloor`). Browser-safe: it imports only the fact kinds.
 */
import { DOCUMENTS_ACCEPTED_KIND, DOCUMENTS_OUTPUT_KIND } from './documents';
import { EXTERNAL_INQUIRY_THREAD_KIND } from './externalInquiry';

export const APP_FACT_KINDS = {
  documents: [DOCUMENTS_OUTPUT_KIND, DOCUMENTS_ACCEPTED_KIND],
  'external-inquiry': [EXTERNAL_INQUIRY_THREAD_KIND],
} as const;
