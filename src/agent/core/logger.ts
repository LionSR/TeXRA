/**
 * Platform-agnostic logging facade for the agent core.
 *
 * Thin wrapper over `platform().log`. Consumer code imports this module
 * for convenience (e.g. `import * as logger from '@agent/core/logger'`).
 *
 * NOTE: Group-context functions (getActiveGroupId, runWithGroupContext) are
 * intentionally NOT exposed here. They are used only by AgentLogger, which
 * calls @logger/logUtils directly. Duplicating AsyncLocalStorage here would
 * cause silent context divergence.
 */
import { tryPlatform } from '@platform/platform';

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

// ---------------------------------------------------------------------------
// Default backend – writes to the process console (for CLI / Electron / tests)
// ---------------------------------------------------------------------------

function timestamp(): string {
  const now = new Date();
  const p = (v: number, w = 2) => v.toString().padStart(w, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}.${p(now.getMilliseconds(), 3)}`;
}

export const consoleBackend: LogBackend = {
  initialize() {},
  debug(ch, msg) {
    console.debug(`[${timestamp()}] [${ch}] ${msg}`);
  },
  info(ch, msg) {
    console.info(`[${timestamp()}] [${ch}] ${msg}`);
  },
  warn(ch, msg) {
    console.warn(`[${timestamp()}] [${ch}] ${msg}`);
  },
  error(ch, msg) {
    console.error(`[${timestamp()}] [${ch}] ${msg}`);
  },
};

// ---------------------------------------------------------------------------
// Public API – delegates to platform().log, falls back to console before init
// ---------------------------------------------------------------------------

/** Get the active log backend, falling back to console if platform not yet initialized.
 *  This is needed because module-level `logger.initialize(CHANNEL)` calls
 *  execute at import time, before initPlatform() runs. */
function backend(): LogBackend {
  return tryPlatform()?.log ?? consoleBackend;
}

export function initialize(channel: string, isAgent = false): void {
  backend().initialize(channel, isAgent);
}

export function debug(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  backend().debug(channel, message, options);
}

export function info(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  backend().info(channel, message, options);
}

export function warn(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  backend().warn(channel, message, options);
}

export function error(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  backend().error(channel, message, options);
}
