/**
 * Platform logging backend interface — infrastructure diagnostics
 * (separate from the agent-transcript logger in `src/logger/`).
 */
export interface LogBackendOptions {
  data?: unknown;
}

export interface LogBackend {
  initialize(channel: string, isAgent?: boolean): void;
  debug(channel: string, message: string, options?: LogBackendOptions): void;
  info(channel: string, message: string, options?: LogBackendOptions): void;
  warn(channel: string, message: string, options?: LogBackendOptions): void;
  error(channel: string, message: string, options?: LogBackendOptions): void;
}
