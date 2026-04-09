/**
 * Platform-agnostic logging facade for the agent core.
 *
 * Delegates to a settable backend. Default: console.
 * VS Code sets the real OutputChannel-backed backend at activation via
 * `setLogBackend()`.
 */
import { AsyncLocalStorage } from 'async_hooks';

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
// Group context (AsyncLocalStorage) – independent of the output backend.
// ---------------------------------------------------------------------------

const contextStorage = new AsyncLocalStorage<Map<string, string[]>>();

function getKey(channel: string, isAgent: boolean): string {
  return `${channel}::${isAgent ? 'agent' : 'shared'}`;
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
// Public API – matches the surface used by src/agent/ and AgentLogger.
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

export function getActiveGroupId(
  channel: string,
  isAgent = false,
): string | undefined {
  return contextStorage.getStore()?.get(getKey(channel, isAgent))?.at(-1);
}

export function runWithGroupContext<T>(
  channel: string,
  groupId: string,
  isAgent: boolean,
  fn: () => Promise<T> | T,
): Promise<T> {
  const parentStore = contextStorage.getStore() ?? new Map<string, string[]>();
  const childStore = new Map(parentStore);
  const key = getKey(channel, isAgent);
  const stack = childStore.get(key) ?? [];
  childStore.set(key, [...stack, groupId]);
  return contextStorage.run(childStore, () => Promise.resolve().then(fn));
}
