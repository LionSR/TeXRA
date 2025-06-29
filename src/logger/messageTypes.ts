export const MESSAGE_TYPES = {
  THINKING: 'thinking',
  SCRATCHPAD: 'scratchpad',
  FILE_LIST: 'fileList',
  DEFAULT: 'default',
} as const;

export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];
