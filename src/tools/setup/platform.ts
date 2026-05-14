/**
 * VS Code-free platform adapter for setup tools.
 *
 * Setup tools live in the `@tools/*` VS Code-free zone, but still need to
 * touch SecretStorage, Memento state, commands, and extensions. Those
 * capabilities are injected from `extension.ts` at activation time.
 *
 * Keep this interface narrow — add methods only when a setup tool needs them.
 */

import type {
  TerminalRunRequest,
  TerminalRunResult,
  TerminalRunner,
} from '@hosts/terminalHost';

/** Per-provider API key surface. */
export interface SetupSecretsAdapter {
  setApiKey(provider: string, key: string): Promise<void>;
  deleteApiKey(provider: string): Promise<void>;
  apiKeyExists(provider: string): Promise<boolean>;
  /**
   * Like `apiKeyExists` but rejects empty values. A stale
   * `PROVIDER_API_KEY=""` env var is "present" but unusable at launch,
   * so setup-readiness checks must use this helper rather than raw
   * `apiKeyExists` to avoid misleading the agent (and the user).
   */
  hasUsableApiKey(provider: string): Promise<boolean>;
  /**
   * Like `apiKeyExists` but only reports SecretStorage entries — ignores
   * environment-variable-backed keys. Needed by `unset_api_key` so the
   * agent doesn't claim to have removed a key that still comes from
   * `PROVIDER_API_KEY` in the user's shell.
   */
  storedApiKeyExists(provider: string): Promise<boolean>;
  anyApiKeyExists(): Promise<boolean>;
  gitHubTokenExists(): Promise<'secret' | 'env' | 'none'>;
  /** List of provider names known to TeXRA (matches SecretManager.API_PROVIDERS). */
  providers: readonly string[];
}

/** Per-command surface. */
export interface SetupCommandAdapter {
  invoke(commandId: string, ...args: unknown[]): Promise<unknown>;
}

/** Extension host surface. */
export interface SetupExtensionAdapter {
  isInstalled(extensionId: string): boolean;
  install(extensionId: string): Promise<void>;
}

/** Auth / Researcher Access surface. */
export interface SetupAuthAdapter {
  getStatus(): Promise<{
    authenticated: boolean;
    email?: string;
    tier?: string;
  }>;
}

/** Configuration-value surface. Reads/writes scoped to `texra.*` keys. */
export interface SetupConfigAdapter {
  /** Read the effective value of a `texra.*` setting. */
  get(key: string): unknown;
  /** Write a `texra.*` setting. `target` selects user vs. workspace scope. */
  update(
    key: string,
    value: unknown,
    target: 'user' | 'workspace',
  ): Promise<void>;
}

/**
 * Integrated-terminal surface. The setup agent uses this for commands
 * the captured-stdio `bash` tool cannot handle: `sudo` password prompts,
 * other interactive TTY prompts, and any flow where the user must type
 * into the running process.
 *
 * Implementations should prefer VS Code's stable `Terminal.shellIntegration`
 * API (since 1.93) so the agent can read back exit code + output. When
 * shell integration is unavailable the implementation may return an
 * `undefined` exit code with empty output — the caller treats that the
 * same as "user interrupted", since neither path tells us anything
 * actionable.
 */
export type SetupTerminalAdapter = TerminalRunner;
export type { TerminalRunRequest, TerminalRunResult };

/** Aggregated setup platform. */
export interface SetupPlatform {
  secrets: SetupSecretsAdapter;
  commands: SetupCommandAdapter;
  extensions: SetupExtensionAdapter;
  auth: SetupAuthAdapter;
  config: SetupConfigAdapter;
  terminal: SetupTerminalAdapter;
}

let platform: SetupPlatform | undefined;

/** Register the platform implementation. Called once from `extension.ts`. */
export function setSetupPlatform(impl: SetupPlatform): void {
  platform = impl;
}

/** Get the registered platform, throwing if not yet wired. */
export function getSetupPlatform(): SetupPlatform {
  if (!platform) {
    throw new Error(
      'Setup platform not initialized. Wire it from extension.ts via setSetupPlatform().',
    );
  }
  return platform;
}
