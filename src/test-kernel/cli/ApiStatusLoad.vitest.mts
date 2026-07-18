import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCliApiMode: vi.fn(),
  getCliAuthProfile: vi.fn(),
  readCliModelAccessStatus: vi.fn(),
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
    mocks.getCliApiMode.mockReset();
    mocks.getCliAuthProfile.mockReset();
    mocks.readCliModelAccessStatus.mockReset();
    mocks.lookupApiKeyOrigin.mockReset();
    mocks.getCliApiMode.mockReturnValue('personal');
    mocks.getCliAuthProfile.mockResolvedValue({ authenticated: false });
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

  it('reports both accounts, the effective route, and its API fallback', async () => {
    mocks.readCliModelAccessStatus.mockResolvedValue({
      active: 'chatgpt',
      chatGptSignedIn: true,
      chatGptAccountLabel: 'chatgpt@example.com',
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
        texraSignedIn: true,
      },
      lines: [
        'model access: ChatGPT subscription',
        'ChatGPT: signed in as chatgpt@example.com',
        'TeXRA: signed in as texra@example.com',
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
