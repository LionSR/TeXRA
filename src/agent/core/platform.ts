/**
 * Composition root for agent-core platform services.
 *
 * Consolidates all platform-specific wiring into a single `initPlatform()`
 * call. Each platform (VS Code, CLI, Electron, tests) calls this once at
 * startup with its own implementations.
 *
 * Consumer code imports the individual accessors (`getConfig`, `getGlobalState`,
 * `logger.*`) from the specific modules — this file only handles initialization.
 */
import { setLogBackend } from './logger';
import { setConfigProvider } from './config';
import { setGlobalState, setWorkspaceState } from './stateStore';
import type { LogBackend } from './logger';
import type { ConfigProvider } from './config';
import type { StateStore } from './stateStore';

export interface PlatformServices {
  config: ConfigProvider;
  globalState: StateStore;
  workspaceState: StateStore;
  log: LogBackend;
}

/**
 * Initialize all agent-core platform services at once.
 * Must be called before any agent code runs.
 */
export function initPlatform(services: PlatformServices): void {
  setConfigProvider(services.config);
  setGlobalState(services.globalState);
  setWorkspaceState(services.workspaceState);
  setLogBackend(services.log);
}

// Re-export types so callers only need one import for the init interface.
export type { LogBackend, ConfigProvider, StateStore };
