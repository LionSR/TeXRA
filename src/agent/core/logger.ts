/**
 * Platform-agnostic logging facade for the agent core.
 *
 * Delegates to a settable backend. Default: console.
 * VS Code sets the real OutputChannel-backed backend at activation via
 * `setLogBackend()`.
 *
 * NOTE: Group-context functions (getActiveGroupId, runWithGroupContext) are
 * intentionally NOT exposed here. They are used only by AgentLogger, which
 * calls @logger/logUtils directly. Duplicating AsyncLocalStorage here would
 * cause silent context divergence.
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

// ---------------------------------------------------------------------------
// Default backend – writes to the process console.
// ---------------------------------------------------------------------------

function timestamp(): string {
  const now = new Date();
  const p = (v: number, w = 2) => v.toString().padStart(w, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}.${p(now.getMilliseconds(), 3)}`;
}

const consoleBackend: LogBackend = {
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
// Settable backend
// ---------------------------------------------------------------------------

let backend: LogBackend = consoleBackend;

/** Replace the log backend. Called once at platform init (e.g. extension activate). */
export function setLogBackend(b: LogBackend): void {
  backend = b;
}

// ---------------------------------------------------------------------------
// Public API – matches the surface used by src/agent/ files.
// ---------------------------------------------------------------------------

export function initialize(channel: string, isAgent = false): void {
  backend.initialize(channel, isAgent);
}

export function debug(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  backend.debug(channel, message, options);
}

export function info(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  backend.info(channel, message, options);
}

export function warn(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  backend.warn(channel, message, options);
}

export function error(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  backend.error(channel, message, options);
}
