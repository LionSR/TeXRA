import type { MessageType } from '@shared/schemas';

export interface LogOptions {
  groupId?: string;
  messageType?: MessageType;
  data?: unknown;
}

export interface LogUtilsOptions extends LogOptions {
  isAgent?: boolean;
}
