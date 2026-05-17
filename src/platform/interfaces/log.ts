/**
 * Platform logging backend interface — infrastructure diagnostics
 * (separate from the agent-transcript logger in `src/logger/`).
 */
export interface LogBackend {
  initialize(channel: string, isAgent?: boolean): void;
  debug(channel: string, message: string): void;
  info(channel: string, message: string): void;
  warn(channel: string, message: string): void;
  error(channel: string, message: string): void;
}
