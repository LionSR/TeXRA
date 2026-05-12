/**
 * Platform logging backend interface.
 */
export interface LogUtilsOptions {
  isAgent?: boolean;
  data?: unknown;
  groupId?: string;
  messageType?: string;
}

export interface LogBackend {
  initialize(channel: string, isAgent?: boolean): void;
  debug(channel: string, message: string, options?: LogUtilsOptions): void;
  info(channel: string, message: string, options?: LogUtilsOptions): void;
  warn(channel: string, message: string, options?: LogUtilsOptions): void;
  error(channel: string, message: string, options?: LogUtilsOptions): void;
}
