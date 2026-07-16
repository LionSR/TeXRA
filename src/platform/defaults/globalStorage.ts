const GLOBAL_STORAGE_LAYOUT = {
  customAgents: 'custom_agents',
  externalInquiryThreads: 'ei_threads',
} as const;

export const CUSTOM_AGENTS_STORAGE_DIR = GLOBAL_STORAGE_LAYOUT.customAgents;
export const EXTERNAL_INQUIRY_THREADS_DIR =
  GLOBAL_STORAGE_LAYOUT.externalInquiryThreads;
