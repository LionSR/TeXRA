import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createHostAuthCoordinator: vi.fn((init: { secrets: unknown }) => ({
    secrets: init.secrets,
  })),
  getCliSecrets: vi.fn(),
  tryPlatform: vi.fn(),
}));

vi.mock('@auth/config', () => ({
  DEFAULT_OAUTH_PROVIDER: 'github',
  DEFAULT_SESSION_EXPIRY_MS: 60_000,
}));

vi.mock('@auth/SupabaseAuthCoordinator', () => ({
  createHostAuthCoordinator: mocks.createHostAuthCoordinator,
}));

vi.mock('@auth/SupabaseClient', () => ({
  SupabaseClient: {
    getRelayAccessToken: vi.fn(),
    getUserTier: vi.fn(),
    isAuthenticated: vi.fn(),
  },
}));

vi.mock('@auth/SupabaseSession', () => ({
  toStorableSupabaseSession: vi.fn((session) => session),
}));

vi.mock('@auth/relayToken', () => ({
  RELAY_TOKEN_ENV_VAR: 'TEXRA_RELAY_TOKEN',
  fetchRelayTokenStatus: vi.fn(),
  getConfiguredRelayToken: vi.fn(),
}));

vi.mock('@auth/serverKeys', () => ({
  getServerSideKeyService: () => ({
    clearAllCaches: vi.fn(),
    setUseIncludedModelAccess: vi.fn(),
  }),
}));

vi.mock('@platform/platform', () => ({
  tryPlatform: mocks.tryPlatform,
}));

vi.mock('@cli/runtime/cliContext', () => ({
  readCliEnv: () => ({}),
}));

vi.mock('@cli/runtime/cliSecrets', () => ({
  getCliSecrets: mocks.getCliSecrets,
}));

vi.mock('@cli/runtime/browser', () => ({
  openBrowser: vi.fn(),
}));

vi.mock('@cli/runtime/supabaseAuthCallbackServer', () => ({
  startLoopbackCallbackServer: vi.fn(),
}));

vi.mock('@cli/runtime/supabaseAuthDeviceCode', () => ({
  pollForDeviceSession: vi.fn(),
  requestDeviceAuthorization: vi.fn(),
}));

async function loadSupabaseAuth() {
  vi.resetModules();
  return import('@cli/runtime/supabaseAuth');
}

describe('CLI Supabase auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryPlatform.mockReturnValue(null);
    mocks.getCliSecrets.mockReturnValue({ kind: 'cli-secrets' });
  });

  it('uses platform-owned secrets after CLI platform init', async () => {
    const platformSecrets = { kind: 'platform-secrets' };
    mocks.tryPlatform.mockReturnValue({ secrets: platformSecrets });
    const { initializeCliSupabaseAuth } = await loadSupabaseAuth();

    initializeCliSupabaseAuth(undefined, '/tmp/sandbox-storage');
    initializeCliSupabaseAuth();

    expect(mocks.createHostAuthCoordinator).toHaveBeenCalledTimes(1);
    expect(mocks.createHostAuthCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: platformSecrets }),
    );
    expect(mocks.getCliSecrets).not.toHaveBeenCalled();
  });

  it('does not rebind no-arg auth init to the default secrets path', async () => {
    const cliSecrets = { kind: 'sandbox-secrets' };
    mocks.getCliSecrets.mockReturnValue(cliSecrets);
    const { initializeCliSupabaseAuth } = await loadSupabaseAuth();

    initializeCliSupabaseAuth(undefined, '/tmp/sandbox-storage');
    initializeCliSupabaseAuth();

    expect(mocks.createHostAuthCoordinator).toHaveBeenCalledTimes(1);
    expect(mocks.getCliSecrets).toHaveBeenCalledWith('/tmp/sandbox-storage');
    expect(mocks.createHostAuthCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: cliSecrets }),
    );
  });
});
