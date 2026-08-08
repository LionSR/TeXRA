import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelAccessForm } from '@cli/chat/tui/forms/ModelAccessForm';
import { cliApiFallbackSelection } from '@cli/runtime/modelAccessRoute';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import { loadInk, renderInteractive } from '@test/support/inkTestHarness.ts';

const loadCliModelAccessOverview = vi.hoisted(() => vi.fn());

vi.mock('@cli/runtime/apiStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/apiStatus')>()),
  loadCliModelAccessOverview,
}));

afterEach(() => vi.clearAllMocks());

async function renderModelAccessForm(apiMode: 'included' | 'personal') {
  const { ink, React } = await loadInk();
  const onSelect = vi.fn();
  const handles = renderInteractive(
    ink,
    React.createElement(ModelAccessForm, {
      apiMode,
      onSelect,
      onCancel: () => undefined,
    }),
    { columns: 120 },
  );

  return { ...handles, onSelect };
}

describe('ModelAccessForm status', () => {
  it('keeps preference actions disabled while status is loading', async () => {
    loadCliModelAccessOverview.mockReturnValue(new Promise(() => undefined));
    const { instance, onSelect, stdin, stdout } =
      await renderModelAccessForm('included');

    try {
      await waitFor(() => stdout.output.includes('Loading current preference'));
      expect(stdout.output).not.toContain('Off ·');

      // Preference rows are disabled until status loads; 1–4 are subscriptions.
      stdin.write('1');
      await Promise.resolve();
      expect(onSelect).not.toHaveBeenCalled();

      stdin.write('5');
      await waitFor(() => onSelect.mock.calls.length === 1);
      expect(onSelect).toHaveBeenCalledWith(
        cliApiFallbackSelection('included'),
      );
    } finally {
      instance.unmount();
    }
  });

  it('keeps preference actions disabled after status loading fails', async () => {
    loadCliModelAccessOverview.mockRejectedValue(
      new Error('model access unavailable'),
    );
    const { instance, onSelect, stdin, stdout } =
      await renderModelAccessForm('included');

    try {
      await waitFor(() => loadCliModelAccessOverview.mock.calls.length > 0);
      await waitFor(() => stdout.output.includes('model access unavailable'));
      expect(stdout.output).toContain('Current preference unavailable');
      expect(stdout.output).not.toContain('Off ·');
      expect(stdout.output).toContain('✓ 5. Included access');

      stdin.write('2');
      await Promise.resolve();
      expect(onSelect).not.toHaveBeenCalled();

      stdin.write('6');
      await waitFor(() => onSelect.mock.calls.length === 1);
      expect(onSelect).toHaveBeenCalledWith(
        cliApiFallbackSelection('personal'),
      );
    } finally {
      instance.unmount();
    }
  });

  it('enables the correct declarative toggle after status loads', async () => {
    loadCliModelAccessOverview.mockResolvedValue({
      access: {
        apiFallback: 'personal',
        preferences: {
          chatGpt: 'on',
          grok: 'off',
          kimiCode: 'on',
          glmCode: 'off',
        },
        chatGptSignedIn: true,
        grokSignedIn: false,
        chatGptAccountLabel: 'user@example.com',
        kimiCodeKeySet: true,
        texraSignedIn: true,
      },
      lines: [],
    });
    const { instance, onSelect, stdin, stdout } =
      await renderModelAccessForm('personal');

    try {
      await waitFor(() => stdout.output.includes('On · user@example.com'));
      stdin.write('1');
      await waitFor(() => onSelect.mock.calls.length === 1);
      expect(onSelect).toHaveBeenCalledWith({
        kind: 'subscription-preference',
        provider: 'chatgpt',
        state: 'off',
      });
    } finally {
      instance.unmount();
    }
  });
});
