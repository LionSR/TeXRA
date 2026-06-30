import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCliApiMode: vi.fn(),
  getCliAuthProfile: vi.fn(),
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

vi.mock('@model/apiProviders', () => ({
  API_PROVIDERS: ['deepseek'],
  lookupApiKeyOrigin: mocks.lookupApiKeyOrigin,
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({ secrets: mocks.secrets }),
}));

const { loadCliApiStatusLines } = await import('@cli/runtime/apiStatus');

describe('loadCliApiStatusLines', () => {
  beforeEach(() => {
    mocks.getCliApiMode.mockReset();
    mocks.getCliAuthProfile.mockReset();
    mocks.lookupApiKeyOrigin.mockReset();
    mocks.getCliApiMode.mockReturnValue('personal');
    mocks.getCliAuthProfile.mockResolvedValue({ authenticated: false });
    mocks.lookupApiKeyOrigin.mockResolvedValue('none');
  });

  it('uses an invocation API mode override for launcher status text', async () => {
    await expect(
      loadCliApiStatusLines({
        apiMode: 'included',
        includeActionHint: true,
      }),
    ).resolves.toEqual([
      'api: included relay',
      'auth: signed out',
      'actions: `texra auth chatgpt login` uses ChatGPT; `texra login` uses Researcher Access',
    ]);
    expect(mocks.getCliApiMode).not.toHaveBeenCalled();
  });

  it('does not ask signed-out personal-key users to add another key', async () => {
    mocks.lookupApiKeyOrigin.mockResolvedValue('env');

    await expect(
      loadCliApiStatusLines({ includeActionHint: true }),
    ).resolves.toEqual([
      'api: personal API keys',
      'auth: signed out',
      'actions: provider keys are configured; use ChatGPT or sign in with Researcher Access',
    ]);
  });
});
