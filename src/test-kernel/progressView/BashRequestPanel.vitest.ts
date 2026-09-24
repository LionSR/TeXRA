// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { BashRequestPanel } from '@progressView/frontend/components/BashRequestPanel';
import type { BashPermission, RunId } from '@shared/schemas';
import { recordPermissionActions } from '@test/support/permissionPanelEvents';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

function createPermission(
  data: Partial<BashPermission>,
): BashRequestPanel['permission'] {
  return {
    kind: 'bash',
    data: {
      requestId: 'bash-request-1',
      allowBypass: false,
      runId: '',
      command: 'echo hi',
      ...data,
    },
  };
}

function mountPanel(
  permission: BashRequestPanel['permission'],
): Promise<BashRequestPanel> {
  return mountComponent<BashRequestPanel>('bash-request-panel', { permission });
}

// Every card shares one action row (BaseRequestPanel); the bash card is where
// it guards the most, so these pin the row's keys here.
describe('bash-request-panel', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/BashRequestPanel'),
  );

  it('offers the run grant on the Approve menu and "a" enables it', async () => {
    const element = await mountPanel(
      createPermission({ allowBypass: true, runId: 'run-1' as RunId }),
    );
    const actions = recordPermissionActions(element);

    expect(
      element.shadowRoot
        ?.querySelector('wa-dropdown-item[value="grant"]')
        ?.textContent?.trim(),
    ).toBe('Approve all commands in this run');

    expect(element.handleKeyboardShortcut('a')).toBe(true);
    expect(actions).toEqual([
      {
        kind: 'policy.set',
        change: {
          field: 'bypass',
          runId: 'run-1',
          bypass: 'bash',
          enabled: true,
        },
      },
      {
        kind: 'request.decide',
        runId: 'run-1',
        requestId: 'bash-request-1',
        decision: { action: 'approve' },
      },
    ]);
  });

  it('rejects on one "n", sends an opened note with it, and never answers on Escape', async () => {
    const element = await mountPanel(
      createPermission({ runId: 'run-1' as RunId }),
    );
    const actions = recordPermissionActions(element);

    expect(element.handleKeyboardShortcut('escape')).toBe(false);
    element.shadowRoot
      ?.querySelector<HTMLElement>('wa-button[data-action="note"]')
      ?.click();
    await element.updateComplete;
    const note = element.shadowRoot?.querySelector<
      HTMLElement & { value: string }
    >('[data-note-input]');
    expect(note).toBeTruthy();
    note!.value = '  use latexmk instead  ';
    // With the note open, "a" must not grant, and Escape closes the note only.
    expect(element.handleKeyboardShortcut('a')).toBe(false);
    expect(actions).toEqual([]);

    expect(element.handleKeyboardShortcut('n')).toBe(true);
    expect(actions).toEqual([
      {
        kind: 'request.decide',
        runId: 'run-1',
        requestId: 'bash-request-1',
        decision: { action: 'reject', feedback: 'use latexmk instead' },
      },
    ]);
  });
});
