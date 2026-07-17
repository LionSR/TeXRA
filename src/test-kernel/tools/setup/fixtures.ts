// Local imports
import type { SetupPlatform, TerminalRunResult } from '@tools/setup/platform';

/**
 * Build a fully stubbed `SetupPlatform` for tool unit tests, with each
 * adapter overridable. The defaults are the "deny / not present"
 * answers — no API keys configured, no extensions installed, not
 * authenticated, no terminal capture — so a test only needs to override
 * the specific surface it exercises.
 */
export function createFakeSetupPlatform(
  overrides: Partial<SetupPlatform> = {},
): SetupPlatform {
  return {
    host: overrides.host ?? 'cli',
    secrets: {
      async deleteApiKey() {},
      async hasUsableApiKey() {
        return false;
      },
      async apiKeyOrigin() {
        return 'none';
      },
      async storedApiKeyExists() {
        return false;
      },
      async anyUsableCredentialExists() {
        return false;
      },
      async gitHubTokenExists() {
        return 'none';
      },
      async listStoredKeys() {
        return [] as readonly string[];
      },
      providers: [],
      ...overrides.secrets,
    },
    commands: {
      async invoke() {},
      ...overrides.commands,
    },
    extensions: {
      isInstalled() {
        return false;
      },
      async install() {},
      ...overrides.extensions,
    },
    auth: {
      async getStatus() {
        return {
          authenticated: false,
          remoteAgentCatalogAvailable: false,
        };
      },
      ...overrides.auth,
    },
    modelAccess: {
      async getChatGptSubscriptionStatus() {
        return { signedIn: false, enabled: false };
      },
      ...overrides.modelAccess,
    },
    config: {
      get() {
        return undefined;
      },
      async update() {},
      ...overrides.config,
    },
    terminal: {
      async runCommand(): Promise<TerminalRunResult> {
        return { exitCode: undefined, output: '', timedOut: false };
      },
      ...overrides.terminal,
    },
  };
}
