import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelAccessForm } from '@cli/chat/tui/forms/ModelAccessForm';
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
  it('does not mark an unverified API fallback active after loading fails', async () => {
    loadCliModelAccessOverview.mockRejectedValue(
      new Error('model access unavailable'),
    );
    const { ink, React } = await loadInk();
    const stdout = new FakeStdout();
    const instance = ink.render(
      React.createElement(ModelAccessForm, {
        apiMode: 'included',
        onSelect: () => undefined,
        onCancel: () => undefined,
      }),
      {
        stdin: new FakeStdin(),
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
      expect(stdout.output).toContain('Sign in through Account');
      expect(stdout.output).not.toContain('Use your TeXRA account');
      expect(stdout.output).not.toContain('✓');
    } finally {
      instance.unmount();
    }
  });
});
