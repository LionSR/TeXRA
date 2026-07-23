import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchRelayUsageSummary: vi.fn(),
  getCliApiMode: vi.fn(),
  getCliAuthProfile: vi.fn(),
  getCliSessionAccessToken: vi.fn(),
  readCliModelAccessStatus: vi.fn(),
  resolveCliUsageTier: vi.fn(),
  lookupApiKeyOrigin: vi.fn(),
  secrets: {},
}));

vi.mock('@cli/runtime/apiAccessMode', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/apiAccessMode')>();
  return {
    ...actual,
    getCliApiMode: mocks.getCliApiMode,
  };
});

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProfile: mocks.getCliAuthProfile,
  getCliSessionAccessToken: mocks.getCliSessionAccessToken,
  resolveCliUsageTier: mocks.resolveCliUsageTier,
}));

vi.mock('@cli/runtime/relayUsage', () => ({
  fetchRelayUsageSummary: mocks.fetchRelayUsageSummary,
}));

vi.mock('@cli/runtime/modelAccessSelection', () => ({
  readCliModelAccessStatus: mocks.readCliModelAccessStatus,
}));

vi.mock('@model/apiProviders', () => ({
  API_PROVIDERS: ['deepseek'],
  lookupApiKeyOrigin: mocks.lookupApiKeyOrigin,
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({ secrets: mocks.secrets }),
}));

const { loadCliApiStatusLines, loadCliModelAccessOverview } =
  await import('@cli/runtime/apiStatus');

describe('loadCliApiStatusLines', () => {
  beforeEach(() => {
    mocks.fetchRelayUsageSummary.mockReset();
    mocks.getCliApiMode.mockReset();
    mocks.getCliAuthProfile.mockReset();
    mocks.getCliSessionAccessToken.mockReset();
    mocks.readCliModelAccessStatus.mockReset();
    mocks.resolveCliUsageTier.mockReset();
    mocks.lookupApiKeyOrigin.mockReset();
    mocks.getCliApiMode.mockReturnValue('personal');
    mocks.getCliAuthProfile.mockResolvedValue({ authenticated: false });
    mocks.getCliSessionAccessToken.mockResolvedValue('session-token');
    mocks.resolveCliUsageTier.mockResolvedValue('free');
    mocks.readCliModelAccessStatus.mockResolvedValue({
      active: 'personal',
      chatGptSignedIn: false,
    });
    mocks.lookupApiKeyOrigin.mockResolvedValue('none');
  });

  it('uses an invocation API mode override for launcher status text', async () => {
    await expect(
      loadCliApiStatusLines({
        apiMode: 'included',
        includeActionHint: true,
      }),
    ).resolves.toEqual([
      'api: included TeXRA access',
      'auth: signed out',
      'actions: choose Model access below; `texra login` signs in to Researcher Access',
    ]);
    expect(mocks.getCliApiMode).not.toHaveBeenCalled();
  });

  it('merges tier and included usage into the auth line', async () => {
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'researcher@example.com',
      tier: 'Ultra',
      credentialSource: 'session',
    });
    mocks.resolveCliUsageTier.mockResolvedValue('Ultra');
    mocks.fetchRelayUsageSummary.mockResolvedValue({ usagePercent: 100.3 });

    await expect(loadCliApiStatusLines()).resolves.toEqual([
      'api: personal API keys',
      'auth: signed in as researcher@example.com · tier: Ultra · included usage this month: 100.3% used, 0% remaining',
    ]);
  });

  it('reports both accounts, the effective route, and its API fallback', async () => {
    mocks.readCliModelAccessStatus.mockResolvedValue({
      active: 'chatgpt',
      chatGptSignedIn: true,
      chatGptAccountLabel: 'chatgpt@example.com',
      kimiCodeKeySet: false,
    });
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'texra@example.com',
    });

    await expect(
      loadCliModelAccessOverview({ apiMode: 'personal' }),
    ).resolves.toEqual({
      access: {
        active: 'chatgpt',
        chatGptSignedIn: true,
        chatGptAccountLabel: 'chatgpt@example.com',
        kimiCodeKeySet: false,
        texraSignedIn: true,
      },
      lines: [
        'model access: ChatGPT subscription',
        'ChatGPT: signed in as chatgpt@example.com',
        'Kimi Code: no key (add with /key)',
        'TeXRA: signed in as texra@example.com',
        'API fallback: Personal API keys',
      ],
    });
  });

  it('reports an active Kimi Code route with its personal fallback', async () => {
    mocks.readCliModelAccessStatus.mockResolvedValue({
      active: 'kimi-code',
      chatGptSignedIn: false,
      kimiCodeKeySet: true,
    });

    await expect(
      loadCliModelAccessOverview({ apiMode: 'personal' }),
    ).resolves.toMatchObject({
      lines: [
        'model access: Kimi Code subscription',
        'ChatGPT: signed out',
        'Kimi Code: key configured',
        'TeXRA: signed out',
        'API fallback: Personal API keys',
      ],
    });
  });

  it('does not ask signed-out personal-key users to add another key', async () => {
    mocks.lookupApiKeyOrigin.mockResolvedValue('env');

    await expect(
      loadCliApiStatusLines({ includeActionHint: true }),
    ).resolves.toEqual([
      'api: personal API keys',
      'auth: signed out',
      'actions: choose Model access below; provider keys are configured',
    ]);
  });
});
