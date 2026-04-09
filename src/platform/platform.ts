/**
 * Platform Abstraction Layer — Composition Root.
 *
 * Single frozen context initialized once at startup by the host
 * (VS Code, CLI, Electron). All core business logic accesses
 * platform services through `platform()`.
 *
 * Pattern: Composition Root (Mark Seemann) + Frozen Object.
 * Industry precedent: Go's context.Context, React's useContext,
 * .NET's IServiceProvider.
 */
import type {
  PlatformConfig,
  PlatformState,
  PlatformLog,
  PlatformFS,
  PlatformWorkspace,
  PlatformStorage,
  PlatformSecrets,
} from './interfaces';

/**
 * The complete set of platform services a host must provide.
 * Frozen after initialization — immutable for the lifetime of the process.
 */
export interface Platform {
  readonly config: PlatformConfig;
  readonly globalState: PlatformState;
  readonly workspaceState: PlatformState;
  readonly log: PlatformLog;
  readonly fs: PlatformFS;
  readonly workspace: PlatformWorkspace;
  readonly storage: PlatformStorage;
  readonly secrets: PlatformSecrets;
}

let _platform: Readonly<Platform> | null = null;

/**
 * Initialize the platform. Must be called exactly once at startup,
 * before any core business logic runs.
 *
 * @example VS Code
 * ```typescript
 * initPlatform({
 *   config: { get: getConfig },
 *   globalState: context.globalState,
 *   workspaceState: context.workspaceState,
 *   log: logger,
 *   fs: new VscodeFileSystem(),
 *   workspace: new VscodeWorkspace(),
 *   storage: new VscodeStorage(context),
 *   secrets: new VscodeSecrets(context),
 * });
 * ```
 *
 * @example CLI
 * ```typescript
 * initPlatform({
 *   config: new FileConfig('~/.texra/config.json'),
 *   globalState: new JsonFileStore('~/.texra/state.json'),
 *   workspaceState: createMemoryStore(),
 *   log: consoleBackend,
 *   fs: nodeBackend,
 *   workspace: { getWorkspacePath: () => cwd(), asRelativePath: ... },
 *   storage: { getStoragePath: () => '~/.texra/storage', ... },
 *   secrets: new EnvSecrets(),
 * });
 * ```
 */
export function initPlatform(services: Platform): void {
  _platform = Object.freeze(services);
}

/**
 * Get the active platform context.
 * Throws if `initPlatform()` hasn't been called yet.
 */
export function platform(): Readonly<Platform> {
  if (!_platform) {
    throw new Error(
      'Platform not initialized — call initPlatform() before using platform services.',
    );
  }
  return _platform;
}

// Re-export the interface types for convenience
export type {
  PlatformConfig,
  PlatformState,
  PlatformLog,
  PlatformFS,
  PlatformWorkspace,
  PlatformStorage,
  PlatformSecrets,
};
