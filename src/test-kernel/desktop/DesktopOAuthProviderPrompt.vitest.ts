// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - auth configuration
import { OAUTH_PROVIDER_LABELS, OAUTH_PROVIDERS } from '@auth/config';

// Local imports - desktop main
import { chooseDesktopOAuthProvider } from '@desktop/main/desktopOAuthProviderPrompt';

function messageBoxAnswering(response: number) {
  return vi.fn(async () => ({ response }));
}

describe('chooseDesktopOAuthProvider', () => {
  it('offers every supported provider plus a cancel button', async () => {
    const showMessageBox = messageBoxAnswering(0);

    await chooseDesktopOAuthProvider(showMessageBox);

    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: [
          ...OAUTH_PROVIDERS.map((provider) => OAUTH_PROVIDER_LABELS[provider]),
          'Cancel',
        ],
        cancelId: OAUTH_PROVIDERS.length,
      }),
    );
  });

  it.each([...OAUTH_PROVIDERS.entries()])(
    'resolves to the provider chosen at button %i',
    async (index, provider) => {
      expect(await chooseDesktopOAuthProvider(messageBoxAnswering(index))).toBe(
        provider,
      );
    },
  );

  it('resolves to undefined when the user cancels', async () => {
    expect(
      await chooseDesktopOAuthProvider(
        messageBoxAnswering(OAUTH_PROVIDERS.length),
      ),
    ).toBeUndefined();
  });
});
