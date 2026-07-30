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

const { loadCliApiStatus, loadCliApiStatusLines, loadCliModelAccessOverview } =
  await import('@cli/runtime/apiStatus');
const { loadCliAccountStatusLines } =
  await import('@cli/chat/tui/commands/handlers/statusAssembly');

describe('loadCliApiStatusLines', () => {
  beforeEach(() => {
    mocks.fetchRelayUsageSummary.mockReset();
    mocks.getCliApiMode.mockReset().mockReturnValue('personal');
    mocks.getCliAuthProfile.mockReset().mockResolvedValue({
      authenticated: false,
    });
    mocks.getCliSessionAccessToken
      .mockReset()
      .mockResolvedValue('session-token');
    mocks.resolveCliUsageTier.mockReset().mockResolvedValue('free');
    mocks.readCliModelAccessStatus.mockReset().mockResolvedValue({
      apiFallback: 'personal',
      preferences: { chatGpt: 'off', kimiCode: 'off' },
      chatGptSignedIn: false,
    });
    mocks.lookupApiKeyOrigin.mockReset().mockResolvedValue('none');
  });

  it.each([
    {
      name: 'without a profile note',
      profile: { authenticated: false },
      lines: ['api: personal API keys', 'auth: signed out'],
      detailLines: [],
    },
    {
      name: 'with a profile note',
      profile: {
        authenticated: false,
        note: 'The configured relay token was rejected.',
      },
      lines: [
        'api: personal API keys',
        'auth: signed out',
        'The configured relay token was rejected.',
      ],
      detailLines: ['The configured relay token was rejected.'],
    },
  ])(
    'preserves signed-out details $name',
    async ({ profile, lines, detailLines }) => {
      mocks.getCliAuthProfile.mockResolvedValue(profile);

      await expect(loadCliApiStatus()).resolves.toEqual({
        lines,
        detailLines,
      });
    },
  );

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

  it('keeps action hints out of detailed account facts', async () => {
    const actionHint =
      'actions: choose Model access below; `texra login` signs in to Researcher Access';

    const status = await loadCliApiStatus({
      apiMode: 'included',
      includeActionHint: true,
    });

    expect(status.lines).toContain(actionHint);
    expect(status.detailLines).not.toContain(actionHint);
    expect(status.detailLines).toEqual([]);
  });

  it('keeps launcher usage compact while exposing detailed account facts', async () => {
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'researcher@example.com',
      tier: 'Ultra',
      credentialSource: 'session',
    });
    mocks.resolveCliUsageTier.mockResolvedValue('Ultra');
    mocks.fetchRelayUsageSummary.mockResolvedValue({ usagePercent: 100.3 });

    await expect(loadCliApiStatus()).resolves.toEqual({
      lines: [
        'api: personal API keys',
        'auth: signed in as researcher@example.com · tier: Ultra · included usage this month: 100.3% used, 0% remaining',
      ],
      detailLines: [
        'tier: Ultra',
        'included usage this month: 100.3% used, 0% remaining',
      ],
    });
    await expect(loadCliApiStatusLines()).resolves.toEqual([
      'api: personal API keys',
      'auth: signed in as researcher@example.com · tier: Ultra · included usage this month: 100.3% used, 0% remaining',
    ]);
  });

  it('preserves profile notes and personal-key warnings in detailed facts', async () => {
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'researcher@example.com',
      tier: 'Researcher',
      credentialSource: 'session',
      note: 'Account metadata may be stale.',
    });
    mocks.lookupApiKeyOrigin.mockResolvedValue('env');
    mocks.resolveCliUsageTier.mockResolvedValue('Researcher');
    mocks.fetchRelayUsageSummary.mockResolvedValue({ usagePercent: 25 });

    await expect(loadCliApiStatus()).resolves.toEqual({
      lines: [
        'api: personal API keys',
        'auth: signed in as researcher@example.com · tier: Researcher · included usage this month: 25.0% used, 75.0% remaining',
        'available: included TeXRA access; personal API keys: DeepSeek',
        'Account metadata may be stale.',
      ],
      detailLines: [
        'available: included TeXRA access; personal API keys: DeepSeek',
        'Account metadata may be stale.',
        'tier: Researcher',
        'included usage this month: 25.0% used, 75.0% remaining',
      ],
    });
  });

  it('explains unavailable usage for relay-token auth without a session', async () => {
    const unavailable =
      'included usage: not available with a CI relay token (run `texra login` to view usage)';
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'CI relay token (TEXRA_RELAY_TOKEN)',
      tier: 'Researcher',
      credentialSource: 'relayToken',
    });
    mocks.getCliSessionAccessToken.mockResolvedValue(null);

    await expect(loadCliApiStatus()).resolves.toEqual({
      lines: [
        'api: personal API keys',
        `auth: signed in as CI relay token (TEXRA_RELAY_TOKEN) · tier: Researcher · ${unavailable}`,
      ],
      detailLines: ['tier: Researcher', unavailable],
    });
    expect(mocks.fetchRelayUsageSummary).not.toHaveBeenCalled();
  });

  it('preserves usage-fetch failures in detailed account facts', async () => {
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'researcher@example.com',
      tier: 'Ultra',
      credentialSource: 'session',
    });
    mocks.resolveCliUsageTier.mockResolvedValue('Ultra');
    mocks.fetchRelayUsageSummary.mockRejectedValue(new Error('quota offline'));

    await expect(loadCliApiStatus()).resolves.toEqual({
      lines: [
        'api: personal API keys',
        'auth: signed in as researcher@example.com · tier: Ultra · included usage: unavailable (quota offline)',
      ],
      detailLines: [
        'tier: Ultra',
        'included usage: unavailable (quota offline)',
      ],
    });
  });

  it('deduplicates profile notes already present in the account overview', async () => {
    const profileNote = 'Account metadata may be stale.';
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: false,
      note: profileNote,
    });

    const lines = await loadCliAccountStatusLines({
      apiMode: 'personal',
      includeApiDetails: true,
    });

    expect(lines.filter((line) => line === profileNote)).toHaveLength(1);
  });

  it('reports both preferences and the API fallback without collapsing them', async () => {
    mocks.readCliModelAccessStatus.mockResolvedValue({
      apiFallback: 'personal',
      preferences: { chatGpt: 'on', kimiCode: 'off' },
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
        apiFallback: 'personal',
        preferences: { chatGpt: 'on', kimiCode: 'off' },
        chatGptSignedIn: true,
        chatGptAccountLabel: 'chatgpt@example.com',
        kimiCodeKeySet: false,
        texraSignedIn: true,
      },
      lines: [
        'ChatGPT preference: On · chatgpt@example.com',
        'Kimi Code preference: Off · key required to enable',
        'API fallback: Personal API keys',
        'TeXRA: signed in as texra@example.com',
      ],
    });
  });

  it('reports Kimi and ChatGPT preference states separately', async () => {
    mocks.readCliModelAccessStatus.mockResolvedValue({
      apiFallback: 'personal',
      preferences: { chatGpt: 'off', kimiCode: 'on' },
      chatGptSignedIn: false,
      kimiCodeKeySet: true,
    });

    await expect(
      loadCliModelAccessOverview({ apiMode: 'personal' }),
    ).resolves.toMatchObject({
      lines: [
        'ChatGPT preference: Off · sign in required to enable',
        'Kimi Code preference: On · key configured',
        'API fallback: Personal API keys',
        'TeXRA: signed out',
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
