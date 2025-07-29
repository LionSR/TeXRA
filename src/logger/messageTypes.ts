export const MESSAGE_TYPES = {
  THINKING: 'thinking',
  SCRATCHPAD: 'scratchpad',
  FILE_LIST: 'fileList',
  MISSING_OUTPUTS: 'missingOutputs',
  LATEXDIFF: 'latexdiff',
  STATISTICS: 'statistics',
  TOOL_USE: 'toolUse',
  TOOL_OUTPUT: 'toolOutput',
  /** Messages that should be hidden from the progress view */
  INTERNAL: 'internal',
  DEFAULT: 'default',
} as const;

export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];
