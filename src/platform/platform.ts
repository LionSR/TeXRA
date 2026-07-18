/**
 * Platform Abstraction Layer — Composition Root.
 *
 * Single frozen context initialized once at startup by the host
 * (VS Code, CLI, Electron). All core business logic accesses
 * platform services through `platform()` or the convenience
 * facades in `@agent/core/`.
 *
 * Pattern: Composition Root (Mark Seemann) + Frozen Object.
 */
import type {
  AgentResumePort,
  AgentDirectoriesPort,
  ConfigProvider,
  StateStore,
  FileSystemProvider,
  ToolMissingHandler,
  WorkspaceProvider,
  StorageProvider,
  LifecycleHost,
  ToolAvailabilityHost,
  FileLockProvider,
} from './interfaces';
import type { LanguageModelPort } from './languageModel';
import type { PlatformSecrets } from './secrets';

/**
 * The complete set of platform services a host must provide.
 * Frozen after initialization — immutable for the lifetime of the process.
 *
 * Note on logging: channel-output logging is its own subsystem
 * (`@logger/logUtils`). Hosts wire the per-channel sink factory via
 * `logUtils.setOutputChannelFactory` directly; the platform abstraction
 * doesn't carry a log backend.
 */
export interface Platform {
  readonly config: ConfigProvider;
  readonly globalState: StateStore;
  readonly workspaceState: StateStore;
  readonly fs: FileSystemProvider;
  readonly workspace: WorkspaceProvider;
  readonly storage: StorageProvider;
  readonly fileLocks: FileLockProvider;
  readonly secrets: PlatformSecrets;
  readonly lifecycle: LifecycleHost;
  readonly agentResume: AgentResumePort;
  readonly agentDirectories: AgentDirectoriesPort;
  readonly toolAvailability: ToolAvailabilityHost;
  /** Subscription-backed models exposed by the active editor host. */
  readonly languageModel: LanguageModelPort;
  /**
   * Surfaces a tool-missing error to the user. Single-implementer (VS Code) —
   * hosts without a UI for this omit it; callers treat an absent port as a
   * no-op.
   */
  readonly toolMissingHandler?: ToolMissingHandler;
}

let _platform: Readonly<Platform> | null = null;

/**
 * Initialize the platform. Must be called exactly once at startup,
 * before any core business logic runs.
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

/**
 * Get the active platform context, or null if not yet initialized.
 *
 * Use this in facade modules that need to tolerate access before
 * `initPlatform()` has been called.
 */
export function tryPlatform(): Readonly<Platform> | null {
  return _platform;
}

/** Get global state if the platform has been initialized. */
export function tryGlobalState(): StateStore | null {
  return _platform?.globalState ?? null;
}

/** Get workspace state if the platform has been initialized. */
export function tryWorkspaceState(): StateStore | null {
  return _platform?.workspaceState ?? null;
}
