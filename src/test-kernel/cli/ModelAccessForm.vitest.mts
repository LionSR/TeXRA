import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelAccessForm } from '@cli/chat/tui/forms/ModelAccessForm';
import { cliApiFallbackSelection } from '@cli/runtime/modelAccessRoute';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import {
  FakeStdin,
  FakeStdout,
  loadInk,
} from '@test/support/inkTestHarness.mts';

const loadCliModelAccessOverview = vi.hoisted(() => vi.fn());

vi.mock('@cli/runtime/apiStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/apiStatus')>()),
  loadCliModelAccessOverview,
}));

afterEach(() => vi.clearAllMocks());

describe('ModelAccessForm status', () => {
  it('keeps preference actions disabled while status is loading', async () => {
    loadCliModelAccessOverview.mockReturnValue(new Promise(() => undefined));
    const { ink, React } = await loadInk();
    const stdin = new FakeStdin();
    const stdout = new FakeStdout(120);
    const onSelect = vi.fn();
    const instance = ink.render(
      React.createElement(ModelAccessForm, {
        apiMode: 'included',
        onSelect,
        onCancel: () => undefined,
      }),
      {
        stdin,
        stdout,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await waitFor(() => stdout.output.includes('Loading current preference'));
      expect(stdout.output).not.toContain('Off ·');

      stdin.write('1');
      await Promise.resolve();
      expect(onSelect).not.toHaveBeenCalled();

      stdin.write('3');
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
    const { ink, React } = await loadInk();
    const stdin = new FakeStdin();
    const stdout = new FakeStdout(120);
    const onSelect = vi.fn();
    const instance = ink.render(
      React.createElement(ModelAccessForm, {
        apiMode: 'included',
        onSelect,
        onCancel: () => undefined,
      }),
      {
        stdin,
        stdout,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await waitFor(() => loadCliModelAccessOverview.mock.calls.length > 0);
      await waitFor(() => stdout.output.includes('model access unavailable'));
      expect(stdout.output).toContain('model access unavailable');
      expect(stdout.output).toContain('Current preference unavailable');
      expect(stdout.output).not.toContain('Off ·');
      expect(stdout.output).toContain('✓ 3. Included TeXRA access');

      stdin.write('2');
      await Promise.resolve();
      expect(onSelect).not.toHaveBeenCalled();

      stdin.write('4');
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
        preferences: { chatGpt: 'on', kimiCode: 'on' },
        chatGptSignedIn: true,
        chatGptAccountLabel: 'user@example.com',
        kimiCodeKeySet: true,
        texraSignedIn: true,
      },
      lines: [],
    });
    const { ink, React } = await loadInk();
    const stdin = new FakeStdin();
    const stdout = new FakeStdout(120);
    const onSelect = vi.fn();
    const instance = ink.render(
      React.createElement(ModelAccessForm, {
        apiMode: 'personal',
        onSelect,
        onCancel: () => undefined,
      }),
      {
        stdin,
        stdout,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

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
